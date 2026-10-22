import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Position, Trade } from "@sniperbot/shared";
import { ExitEngine } from "./exit-engine.js";
import { env } from "../config/env.js";
import { PositionStore } from "../state/position-store.js";
import { MarketFeed, type MarketQuote } from "../execution/market-price.js";
import { SOL_MINT } from "../feeds/parsers/common.js";
import { PUMPFUN_START_PRICE_SOL } from "../feeds/parsers/pumpfun.js";

const MIN = 60_000;

function quietStore(): PositionStore {
  const store = new PositionStore();
  const s = store as unknown as Record<string, () => Promise<void>>;
  s.persistOpen = s.persistTrade = s.persistClose = async () => undefined;
  return store;
}

function position(openedAgoMs: number): Position {
  return {
    id: "p1",
    poolAddress: "MINT",
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
    tpLadder: [{ gainPct: 50, sellPct: 25, hit: false }],
    stopLossPct: -40,
    trailingStopPct: 30,
    trailingStopActivationPct: 200,
    trailingStopArmed: false,
    timeExitMin: 30,
    filterScore: 90,
    openedAt: Date.now() - openedAgoMs,
    status: "open",
  };
}

/** A real-pool position (no simulated profile) priced by a feed we control. */
function setup(openedAgoMs: number, price: number | null) {
  const store = quietStore();
  const prices = new Map<string, MarketQuote>();
  if (price !== null) prices.set("MINT", { priceUsd: price, liquidityUsd: 50_000, decimals: 6, at: Date.now() });
  const feed = new MarketFeed(() => ["MINT"], async () => prices);
  const engine = new ExitEngine(store, 1, feed);
  store.add(position(openedAgoMs), undefined, {} as Trade);
  const tick = () => (engine as unknown as { tick(): void }).tick();
  const setPrice = (priceUsd: number) =>
    prices.set("MINT", { priceUsd, liquidityUsd: 50_000, decimals: 6, at: Date.now() });
  // a SOL price at which the curve's start is exactly $1
  const startAt = (usd: number) =>
    prices.set(SOL_MINT, { priceUsd: usd / PUMPFUN_START_PRICE_SOL, liquidityUsd: null, decimals: 9, at: Date.now() });
  return { store, feed, tick, setPrice, startAt, engine };
}

/** Run `fn` with the clock moved forward by `ms`. */
function later(ms: number, fn: () => void): void {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    fn();
  } finally {
    Date.now = realNow;
  }
}

describe("exits on market prices", () => {
  const realRandom = Math.random;
  beforeEach(() => {
    Math.random = () => 0.5;
  });
  afterEach(() => {
    Math.random = realRandom;
  });

  test("the market price drives the stop-loss, not a simulation", async () => {
    const { store, feed, tick } = setup(MIN, 0.5);
    await feed.poll();
    tick();
    assert.equal(store.count(), 0);
    assert.equal(store.recentlyClosed(1)[0]?.closeReason, "stop-loss");
  });

  test("a market move to +50% takes the first profit", async () => {
    const { store, feed, tick } = setup(MIN, 1.6);
    await feed.poll();
    tick();
    const p = store.list()[0];
    assert.equal(p?.status, "partial");
    assert.equal(p?.remainingTokens, 75);
    assert.ok(store.getStats().realizedPnlUsd > 0);
  });

  test("before TP1 a dip below entry is held; after TP1 the stop sits at break-even", async () => {
    const { store, feed, tick, setPrice } = setup(MIN, 0.95);
    await feed.poll();
    tick();
    assert.equal(store.count(), 1, "-5% is far from the -40% stop");

    setPrice(1.6);
    await feed.poll();
    tick();
    assert.equal(store.list()[0]?.status, "partial");

    setPrice(0.99);
    await feed.poll();
    tick();
    assert.equal(store.count(), 0);
    const closed = store.recentlyClosed(1)[0];
    assert.equal(closed?.closeReason, "stop-loss");
    assert.ok((closed?.realizedPnlUsd ?? 0) > 0, "TP1's profit outweighs the break-even exit");
  });

  test("a pump.fun coin sitting at its curve's start for 3 minutes is sold as dead", async () => {
    const { store, feed, tick, startAt } = setup(MIN, 0.8);
    startAt(0.79);
    await feed.poll();
    tick();
    assert.equal(store.count(), 1, "the floor was only just reached");
    later(2 * MIN, tick);
    assert.equal(store.count(), 1);
    later(3 * MIN, tick);
    assert.equal(store.count(), 0);
    assert.equal(store.recentlyClosed(1)[0]?.closeReason, "dead-coin");
  });

  test("a coin that leaves the floor starts its 3 minutes over", async () => {
    const { store, feed, tick, setPrice, startAt } = setup(MIN, 0.8);
    startAt(0.79);
    await feed.poll();
    tick();
    setPrice(0.9);
    await feed.poll();
    later(2 * MIN, tick);
    setPrice(0.8);
    await feed.poll();
    later(4 * MIN, tick);
    assert.equal(store.count(), 1, "back at the floor for 2 minutes, not 3");
  });

  test("HARD_EXIT_MIN sells a winner too, once its minutes are up", async () => {
    const mutable = env as { HARD_EXIT_MIN: number };
    const before = mutable.HARD_EXIT_MIN;
    mutable.HARD_EXIT_MIN = 10;
    try {
      const { store, feed, tick } = setup(11 * MIN, 1.3);
      await feed.poll();
      tick();
      assert.equal(store.count(), 0);
      const closed = store.recentlyClosed(1)[0];
      assert.equal(closed?.closeReason, "time-exit");
      assert.ok((closed?.realizedPnlUsd ?? 0) > 0, "+30% was taken, not lost");
    } finally {
      mutable.HARD_EXIT_MIN = before;
    }
  });

  test("a trade on the curve below the stop closes the position at once, with no tick", () => {
    const { store, engine } = setup(MIN, null);
    engine.onCurveTrade("MINT", 0.5, 50_000);
    assert.equal(store.count(), 0);
    assert.equal(store.recentlyClosed(1)[0]?.closeReason, "stop-loss");
  });

  test("a fresh curve price outranks the polled market price", async () => {
    const { store, feed, tick, engine } = setup(MIN, 1.0);
    await feed.poll();
    engine.onCurveTrade("MINT", 1.6, 50_000);
    tick();
    assert.equal(store.list()[0]?.status, "partial", "+60% on the curve took TP1, though the poll said +0%");
  });

  test("trades on other coins leave a position alone", () => {
    const { store, engine } = setup(MIN, null);
    engine.onCurveTrade("OTHER", 0.1, 50_000);
    assert.equal(store.count(), 1);
  });

  test("an unpriced position waits inside its window", () => {
    const { store, tick } = setup(MIN, null);
    tick();
    assert.equal(store.count(), 1);
  });

  test("past its window, a token nobody quotes is written off — but not on the first empty tick", () => {
    const { store, tick } = setup(40 * MIN, null);
    tick();
    assert.equal(store.count(), 1, "a restart's first ticks come before the first price");

    const realNow = Date.now;
    Date.now = () => realNow() + 4 * MIN;
    try {
      tick();
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.count(), 0);
    const closed = store.recentlyClosed(1)[0];
    assert.equal(closed?.closeReason, "time-exit");
    assert.ok((closed?.realizedPnlUsd ?? 0) <= -100, "written off at $0");
  });
});
