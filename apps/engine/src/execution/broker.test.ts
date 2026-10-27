import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PoolEvent } from "@sniperbot/shared";
import { PaperBroker } from "./broker.js";
import { PositionStore } from "../state/position-store.js";
import type { EntryQuote, MarketFeed } from "./market-price.js";

function quietStore(): PositionStore {
  const store = new PositionStore();
  const s = store as unknown as Record<string, () => Promise<void>>;
  s.persistOpen = s.persistTrade = s.persistClose = async () => undefined;
  return store;
}

const pool = { poolAddress: "P", tokenMint: "MintMintMint", source: "raydium-amm", detectedAt: 0 } as PoolEvent;

function makeBroker(quote: EntryQuote) {
  const store = quietStore();
  const feed = { entryQuote: async () => quote, solPriceUsd: async () => 200 } as unknown as MarketFeed;
  const broker = new PaperBroker(store, feed);
  return { broker, store };
}

describe("paper broker", () => {
  const realRandom = Math.random;
  beforeEach(() => {
    // no simulated failed fill, no simulated sandwich
    Math.random = () => 0.5;
  });
  afterEach(() => {
    Math.random = realRandom;
  });

  test("buys nothing while trading is off", async () => {
    const { broker, store } = makeBroker({ ok: true, priceUsd: 2, liquidityUsd: 100_000, premiumPct: 0 });
    assert.equal(await broker.buy(pool, 100), null);
    assert.equal(store.count(), 0);
  });

  test("buys at the executable quote, and a coin only once", async () => {
    const { broker, store } = makeBroker({ ok: true, priceUsd: 2, liquidityUsd: 100_000, premiumPct: 0 });
    broker.setEnabled(true);
    const [a, b] = await Promise.all([broker.buy(pool, 100), broker.buy(pool, 100)]);
    assert.ok(a && !b);
    assert.equal(a.entryPriceUsd, 2);
    assert.equal(a.entrySizeUsd, 100);
    assert.equal(await broker.buy(pool, 100), null, "still held");
    assert.equal(store.count(), 1);
  });

  test("no trustworthy price, no buy", async () => {
    const { broker, store } = makeBroker({ ok: false, reason: "no market price" });
    broker.setEnabled(true);
    assert.equal(await broker.buy(pool, 100), null);
    assert.equal(store.count(), 0);
    assert.equal(broker.getStats().noPrice, 1);
  });

  test("sells part of a position, then the rest, with the strategy's reason", async () => {
    const { broker, store } = makeBroker({ ok: true, priceUsd: 2, liquidityUsd: 1_000_000, premiumPct: 0 });
    broker.setEnabled(true);
    const p = (await broker.buy(pool, 100))!;
    broker.sell(p.id, 0.5, "half off", 4, 1_000_000);
    assert.equal(store.get(p.id)?.position.status, "partial");
    assert.ok(Math.abs(store.get(p.id)!.position.remainingTokens - p.initialTokens / 2) < 1e-9);
    broker.sell(p.id, 1, "all out", 4, 1_000_000);
    assert.equal(store.count(), 0);
    const closed = store.recentlyClosed(1)[0]!;
    assert.equal(closed.closeReason, "all out");
    assert.ok(closed.realizedPnlUsd > 90, "doubled: about +100 less fees and slippage");
  });
});
