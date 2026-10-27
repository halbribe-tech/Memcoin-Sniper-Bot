import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { curveFillPct, LaunchTracker } from "./launch-tracker.js";
import { decodePumpCreateEvent } from "./parsers/pumpfun-event.js";

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
function trade(
  user: string,
  isBuy: boolean,
  tokens: bigint,
  opts: { priceX?: number; sol?: number; fillPct?: number } = {},
): string[] {
  const b = Buffer.alloc(113);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(b, 0);
  decodeKey(MINT).copy(b, 8);
  b.writeBigUInt64LE(BigInt(Math.round((opts.sol ?? 0) * 1e9)), 40);
  b.writeBigUInt64LE(tokens * M, 48);
  b[56] = isBuy ? 1 : 0;
  decodeKey(user).copy(b, 57);
  if (opts.fillPct !== undefined) {
    // reserves with fillPct% of the 793.1M sellable tokens bought, on the constant product
    const vtr = 1_073_000_000_000_000n - BigInt(Math.round(opts.fillPct * 7_931_000_000_000));
    b.writeBigUInt64LE((30_000_000_000n * 1_073_000_000_000_000n) / vtr, 97);
    b.writeBigUInt64LE(vtr, 105);
  } else {
    // reserves putting the curve at priceX × its start (30 SOL / 1.073B tokens)
    b.writeBigUInt64LE(BigInt(Math.round(30e9 * (opts.priceX ?? 1))), 97);
    b.writeBigUInt64LE(1_073_000_000_000_000n, 105);
  }
  return [`Program data: ${b.toString("base64")}`];
}

/** A CompleteEvent log line: user, mint, bonding curve, timestamp, quote mint. */
function complete(mint: string): string[] {
  const b = Buffer.alloc(8 + 32 + 32 + 32 + 8 + 32);
  Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]).copy(b, 0);
  decodeKey(wallet()).copy(b, 8);
  decodeKey(mint).copy(b, 40);
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

describe("curve", () => {
  function tracker() {
    const t = new LaunchTracker();
    const completed: string[] = [];
    const trades: number[] = [];
    t.on("complete", (m) => completed.push(m));
    t.on("trade", (tr) => trades.push(tr.slot));
    t.ingest(CREATE_WITH_DEV_BUY, SLOT, 0);
    return { t, completed, trades };
  }

  test("every trade on a tradable launch is passed on with its slot and price", () => {
    const { t, trades } = tracker();
    t.ingest(trade(wallet(), true, 10n, { fillPct: 40 }), SLOT + 3, 1_000);
    assert.deepEqual(trades.slice(-1), [SLOT + 3]);
    assert.ok(Math.abs(t.stats(MINT, 1_000)!.curveFillPct - 40) < 1e-6);
  });

  test("a CompleteEvent marks the curve complete and is passed on for any mint", () => {
    const { t, completed } = tracker();
    const other = wallet();
    t.ingest([...trade(wallet(), true, 10n, { fillPct: 100 }), ...complete(MINT)], SLOT + 20, 8_000);
    t.ingest(complete(other), SLOT + 21, 9_000);
    assert.equal(t.curveState(MINT)?.complete, true);
    assert.deepEqual(completed, [MINT, other]);
  });

  test("curveFillPct reads the share of the sellable supply bought", () => {
    assert.equal(curveFillPct(1_073_000_000_000_000n), 0);
    assert.ok(Math.abs(curveFillPct(279_900_000_000_000n) - 100) < 1e-9);
  });
});

