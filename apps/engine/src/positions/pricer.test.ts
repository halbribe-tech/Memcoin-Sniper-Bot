import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Position, Trade } from "@sniperbot/shared";
import { PositionPricer } from "./pricer.js";
import { PositionStore } from "../state/position-store.js";
import type { MarketFeed, MarketQuote } from "../execution/market-price.js";
import type { PaperBroker } from "../execution/broker.js";
import type { Strategy, StrategyContext } from "../strategy/types.js";

function setup(onPrice: Strategy["onPrice"], quote: MarketQuote | undefined) {
  const store = new PositionStore();
  const s = store as unknown as Record<string, () => Promise<void>>;
  s.persistOpen = s.persistTrade = s.persistClose = async () => undefined;
  store.add(
    {
      id: "p1",
      poolAddress: "P",
      tokenMint: "MINT",
      source: "pumpfun",
      mode: "paper",
      entryPriceUsd: 1,
      entrySizeUsd: 100,
      initialTokens: 100,
      remainingTokens: 100,
      currentPriceUsd: 1,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      realizedPnlUsd: 0,
      peakPriceUsd: 1,
      peakGainPct: 0,
      openedAt: Date.now(),
      status: "open",
    } as Position,
    {} as Trade,
  );
  const sells: Array<[string, number, string, number]> = [];
  const broker = { sell: (id: string, f: number, r: string, price: number) => sells.push([id, f, r, price]) } as unknown as PaperBroker;
  const market = { get: () => quote } as unknown as MarketFeed;
  const pricer = new PositionPricer(store, market, broker, { onPool: () => null, onTrade: () => null, onPrice }, {} as StrategyContext);
  const tick = () => (pricer as unknown as { tick(): void }).tick();
  return { store, sells, pricer, tick };
}

describe("position pricer", () => {
  test("each curve trade prices the position and asks the strategy", () => {
    const seen: number[] = [];
    const { pricer, sells, store } = setup((p) => {
      seen.push(p.currentPriceUsd);
      return p.currentPriceUsd >= 2 ? { fraction: 1, reason: "doubled" } : null;
    }, undefined);
    pricer.onCurveTrade("MINT", 1.5, 50_000);
    pricer.onCurveTrade("MINT", 2, 50_000);
    assert.deepEqual(seen, [1.5, 2]);
    assert.deepEqual(sells, [["p1", 1, "doubled", 2]]);
    assert.equal(store.get("p1")?.position.peakGainPct, 100);
  });

  test("without a fresh curve price the polled market price is used; no price, no call", () => {
    let calls = 0;
    const withQuote = setup(() => (calls++, null), { priceUsd: 1.2, liquidityUsd: 10_000, decimals: 6, at: Date.now() });
    withQuote.tick();
    assert.equal(calls, 1);
    assert.equal(withQuote.store.get("p1")?.position.currentPriceUsd, 1.2);

    calls = 0;
    const unpriced = setup(() => (calls++, null), undefined);
    unpriced.tick();
    assert.equal(calls, 0);
  });

  test("a strategy that throws holds the position", () => {
    const { pricer, sells, store } = setup(() => {
      throw new Error("bug");
    }, undefined);
    pricer.onCurveTrade("MINT", 3, 50_000);
    assert.equal(sells.length, 0);
    assert.equal(store.count(), 1);
  });
});
