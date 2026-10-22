import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { PoolEvent } from "@sniperbot/shared";
import { LaunchTracker, launchTracker } from "./launch-tracker.js";
import { decodePumpCreateEvent } from "./parsers/pumpfun-event.js";
import { bundledLaunchFilter } from "../filters/bundled-launch.js";
import type { FilterContext } from "../filters/types.js";

// a real create_v2 with the dev's 0.99 SOL buy in the same transaction
const CREATE_WITH_DEV_BUY = [
  "Program data: G3KpTd7rY3YLAAAARUNIT1RSSUJCTEULAAAARUNIT1RSSUJCTEVAAAAAaHR0cHM6Ly9tZXRhLnV4ZW50by5pby9kYXRhLzk5ZDBkYzJlLTMzYWMtNDA3My04ZGI4LTliMmZhMTZhZDZjMKtnqF1nIHlDjzegmY8vSWYOkqXJTddaALUfCEQInnjvaFAdXaHjeLFx7iTOO/TekZgPQCuiJuwHGd6kJ9xschxfiKikr+BY96Qd2AgcDtGMnwLyvebsPRf3Az/1lpHqzl+IqKSv4Fj3pB3YCBwO0YyfAvK95uw9F/cDP/WWkerOLwLZagAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACsI/wGAAAAAAAAAAAAAAAAAA==",
  "Program data: vdt/007mYe6rZ6hdZyB5Q483oJmPL0lmDpKlyU3XWgC1HwhECJ5477Bo3joAAAAA6oVanxofAAABX4iopK/gWPekHdgIHA7RjJ8C8r3m7D0X9wM/9ZaR6s4vAtlqAAAAALAUAjcHAAAAFop9qMiwAwCwaN46AAAAABbyalw3sgIASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZfAAAAAAAAAD0rjwAAAAAAX4iopK/gWPekHdgIHA7RjJ8C8r3m7D0X9wM/9ZaR6s4eAAAAAAAAABM2LQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAGJ1eV9leGFjdF9zb2xfaW4AAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAnpVHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwaN46AAAAALAUAjcHAAAAsGjeOgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
];
const created = decodePumpCreateEvent(CREATE_WITH_DEV_BUY)!;
const MINT = created.mint;
const DEV = created.user;
const SLOT = 1000;
const M = 1_000_000n; // 1 token in raw units

/** A TradeEvent log line, laid out as pump's IDL writes it. */
function trade(user: string, isBuy: boolean, tokens: bigint, opts: { priceX?: number; sol?: number } = {}): string[] {
  const b = Buffer.alloc(113);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(b, 0);
  decodeKey(MINT).copy(b, 8);
  b.writeBigUInt64LE(BigInt(Math.round((opts.sol ?? 0) * 1e9)), 40);
  b.writeBigUInt64LE(tokens * M, 48);
  b[56] = isBuy ? 1 : 0;
  decodeKey(user).copy(b, 57);
  // reserves putting the curve at priceX × its start (30 SOL / 1.073B tokens)
  b.writeBigUInt64LE(BigInt(Math.round(30e9 * (opts.priceX ?? 1))), 97);
  b.writeBigUInt64LE(1_073_000_000_000_000n, 105);
  return [`Program data: ${b.toString("base64")}`];
}
const decodeKey = (key: string) => Buffer.from(new PublicKey(key).toBytes());
const wallet = () => Keypair.generate().publicKey.toBase58();

describe("launch tracker", () => {
  test("the dev's buy in the create transaction is counted as the dev's", () => {
    const t = new LaunchTracker();
    t.ingest(CREATE_WITH_DEV_BUY, SLOT);
    const s = t.stats(MINT)!;
    assert.ok(s.devBoughtPct > 3 && s.devBoughtPct < 4, `0.99 SOL buys ~3.4% of supply, got ${s.devBoughtPct}`);
    assert.equal(s.devSoldPct, 0);
    assert.equal(s.launchBuyers, 0);
  });

  test("buyers in the launch slot and the next are tracked through their sells; later buyers are not", () => {
    const t = new LaunchTracker();
    t.ingest(CREATE_WITH_DEV_BUY, SLOT);
    const a = wallet();
    const b = wallet();
    t.ingest(trade(a, true, 100_000_000n), SLOT);
    t.ingest(trade(b, true, 100_000_000n), SLOT + 1);
    t.ingest(trade(wallet(), true, 300_000_000n), SLOT + 5);
    assert.equal(t.stats(MINT)!.launchBuyers, 2);
    assert.ok(Math.abs(t.stats(MINT)!.launchBuyersHeldPct - 20) < 1e-9);
    t.ingest(trade(a, false, 60_000_000n), SLOT + 40);
    assert.ok(Math.abs(t.stats(MINT)!.launchBuyersHeldPct - 14) < 1e-9);
  });

  test("a dev selling their buy shows as sold", () => {
    const t = new LaunchTracker();
    t.ingest(CREATE_WITH_DEV_BUY, SLOT);
    const bought = t.stats(MINT)!.devBoughtPct;
    t.ingest(trade(DEV, false, BigInt(Math.floor((bought / 100) * 1e9 * 0.6))), SLOT + 30);
    assert.ok(Math.abs(t.stats(MINT)!.devSoldPct - 60) < 0.1);
  });
});

describe("bundled-launch on tracked launches", () => {
  const ctx = { isSynthetic: false, cfg: { bundledLaunchReject: true } } as FilterContext;
  const pool = { source: "pumpfun", tokenMint: MINT, poolAddress: MINT } as PoolEvent;

  test("rejects while launch-slot buyers hold 15%+, passes once they have sold down, rejects a selling dev", async () => {
    launchTracker.ingest(CREATE_WITH_DEV_BUY, SLOT);
    const sniper = wallet();
    launchTracker.ingest(trade(sniper, true, 200_000_000n), SLOT);
    assert.equal((await bundledLaunchFilter.evaluate(pool, ctx)).status, "fail");

    launchTracker.ingest(trade(sniper, false, 100_000_000n), SLOT + 50);
    assert.equal((await bundledLaunchFilter.evaluate(pool, ctx)).status, "pass");

    launchTracker.ingest(trade(DEV, false, 30_000_000n), SLOT + 60);
    const r = await bundledLaunchFilter.evaluate(pool, ctx);
    assert.equal(r.status, "fail");
    assert.match(r.reason, /dev already sold/);
  });

  test("a coin this run never saw launch is skipped, not passed", async () => {
    const r = await bundledLaunchFilter.evaluate({ ...pool, tokenMint: wallet() }, ctx);
    assert.equal(r.status, "skip");
  });
});

describe("breakouts", () => {
  const rule = { multiple: 2, minAgeSec: 5, minBuySol: 22, maxDevSoldPct: 100 };
  function tracker() {
    const t = new LaunchTracker();
    t.setBreakoutRule(rule);
    const fired: string[] = [];
    t.on("breakout", (m) => fired.push(m));
    t.ingest(CREATE_WITH_DEV_BUY, SLOT, 0);
    return { t, fired };
  }

  test("fires once when the curve doubles on 22+ SOL of buying, after 5s", () => {
    const { t, fired } = tracker();
    t.ingest(trade(wallet(), true, 10n, { priceX: 1.5, sol: 10 }), SLOT + 5, 3_000);
    t.ingest(trade(wallet(), true, 10n, { priceX: 2.1, sol: 13 }), SLOT + 10, 4_000);
    assert.deepEqual(fired, [], "doubled and 23 SOL, but only 4s old");
    t.ingest(trade(wallet(), true, 10n, { priceX: 2.2, sol: 1 }), SLOT + 20, 8_000);
    assert.deepEqual(fired, [MINT]);
    t.ingest(trade(wallet(), true, 10n, { priceX: 3, sol: 5 }), SLOT + 30, 9_000);
    assert.deepEqual(fired, [MINT], "a launch breaks out once");
  });

  test("not on thin buying, and not once the dev has sold out", () => {
    const thin = tracker();
    thin.t.ingest(trade(wallet(), true, 10n, { priceX: 2.5, sol: 5 }), SLOT + 20, 8_000);
    assert.deepEqual(thin.fired, [], "5 SOL of buying is not a breakout");

    const sold = tracker();
    sold.t.ingest(trade(DEV, false, 40_000_000n), SLOT + 2, 2_000);
    sold.t.ingest(trade(wallet(), true, 10n, { priceX: 2.5, sol: 30 }), SLOT + 20, 8_000);
    assert.deepEqual(sold.fired, [], "the dev sold their whole buy");
  });

  test("without a rule nothing fires", () => {
    const t = new LaunchTracker();
    const fired: string[] = [];
    t.on("breakout", (m) => fired.push(m));
    t.ingest(CREATE_WITH_DEV_BUY, SLOT, 0);
    t.ingest(trade(wallet(), true, 10n, { priceX: 3, sol: 40 }), SLOT + 20, 8_000);
    assert.deepEqual(fired, []);
  });
});
