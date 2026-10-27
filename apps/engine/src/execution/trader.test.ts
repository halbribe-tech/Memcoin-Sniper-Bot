import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorVerdict, PoolEvent, Position } from "@sniperbot/shared";
import { Trader } from "./trader.js";
import type { PositionStore } from "../state/position-store.js";
import type { PnlTracker } from "../analytics/pnl-tracker.js";
import type { DrawdownCircuit } from "../risk/drawdown-circuit.js";
import type { EntryQuote, MarketFeed } from "./market-price.js";
import { PUMPFUN_START_PRICE_SOL } from "../feeds/parsers/pumpfun.js";
import { launchTracker } from "../feeds/launch-tracker.js";

const verdict = { decision: "snipe", poolAddress: "P", totalScore: 90 } as OrchestratorVerdict;
const pool = { poolAddress: "P", tokenMint: "MintMintMint" } as PoolEvent;

function makeTrader() {
  const calls = { canTrade: 0, add: 0 };
  // The circuit is the first thing an enabled trader consults; blocking there
  // keeps the test off the paper executor while proving the gate was passed.
  const circuit = {
    canTrade: () => {
      calls.canTrade++;
      return { allowed: false, reason: "test" };
    },
  } as unknown as DrawdownCircuit;
  const store = { add: () => calls.add++, count: () => 0 } as unknown as PositionStore;
  return { trader: new Trader(store, {} as PnlTracker, circuit), calls };
}

describe("trading switch", () => {
  test("a fresh engine opens nothing until trading is started", () => {
    const { trader, calls } = makeTrader();
    assert.equal(trader.isEnabled(), false);
    trader.handleVerdict(verdict, pool);
    assert.deepEqual(calls, { canTrade: 0, add: 0 });
    assert.equal(trader.getStats().skippedDisabled, 1);
  });

  test("once started, a snipe goes on to the risk checks", () => {
    const { trader, calls } = makeTrader();
    trader.setEnabled(true);
    trader.handleVerdict(verdict, pool);
    assert.equal(calls.canTrade, 1);
  });

  test("stopping again blocks the next snipe", () => {
    const { trader, calls } = makeTrader();
    trader.setEnabled(true);
    trader.setEnabled(false);
    trader.handleVerdict(verdict, pool);
    assert.equal(calls.canTrade, 0);
  });
});

describe("entries", () => {
  const realRandom = Math.random;
  beforeEach(() => {
    // no simulated failed fill, no simulated sandwich
    Math.random = () => 0.5;
  });
  afterEach(() => {
    Math.random = realRandom;
  });

  function makeLiveTrader(quote: EntryQuote) {
    const added: { position: Position; profile: unknown }[] = [];
    let quoted = 0;
    const store = {
      count: () => added.length,
      list: () => added.map((a) => a.position),
      add: (position: Position, profile: unknown) => added.push({ position, profile }),
    } as unknown as PositionStore;
    const pnl = { buildSnapshot: () => ({ openExposureUsd: 0, balanceUsd: 10_000 }) } as unknown as PnlTracker;
    const circuit = { canTrade: () => ({ allowed: true }) } as unknown as DrawdownCircuit;
    const feed = {
      entryQuote: async () => {
        quoted++;
        return quote;
      },
    } as unknown as MarketFeed;
    const trader = new Trader(store, pnl, circuit, feed);
    trader.setEnabled(true);
    return { trader, added, quoted: () => quoted };
  }

  const realPool = { poolAddress: "P", tokenMint: "MintMintMint", initialPriceUsd: 0.000005, initialLiquidityUsd: 5400, detectedAt: 0 } as PoolEvent;

  test("a real pool nobody quotes is not bought, and its rate-limit slot is given back", async () => {
    const { trader, added } = makeLiveTrader({ ok: false, reason: "no market price" });
    await trader.handleVerdict(verdict, realPool);
    assert.equal(added.length, 0);
    assert.equal(trader.getStats().skippedNoPrice, 1);
    // three more tries still reach the price lookup: nothing was left reserved
    for (let i = 0; i < 3; i++) await trader.handleVerdict(verdict, realPool);
    assert.equal(trader.getStats().skippedRate, 0);
  });

  test("a real pool is bought at what a real buy would pay, not the parser's estimate", async () => {
    const { trader, added } = makeLiveTrader({ ok: true, priceUsd: 2, liquidityUsd: 100_000, premiumPct: 3 });
    await trader.handleVerdict(verdict, realPool);
    assert.equal(added.length, 1);
    // the executable quote already carries the impact: no second slippage charge
    assert.equal(added[0]!.position.entryPriceUsd, 2);
    assert.equal(added[0]!.profile, undefined, "a real pool is priced by the feed, not simulated");
  });

  test("a coin is held at most once, even when two verdicts arrive together", async () => {
    const { trader, added } = makeLiveTrader({ ok: true, priceUsd: 2, liquidityUsd: 100_000, premiumPct: 3 });
    await Promise.all([trader.handleVerdict(verdict, realPool), trader.handleVerdict(verdict, realPool)]);
    await trader.handleVerdict(verdict, realPool);
    assert.equal(added.length, 1);
  });

  test("a synthetic pool keeps its simulated price and never asks the market", async () => {
    const { trader, added, quoted } = makeLiveTrader({ ok: false, reason: "unused" });
    const synthetic = { ...realPool, rawEvent: { synthetic: true, bucket: "SOLID" } } as PoolEvent;
    await trader.handleVerdict(verdict, synthetic);
    assert.equal(quoted(), 0);
    assert.equal(added.length, 1);
    assert.ok(added[0]!.profile, "synthetic positions carry a price profile");
  });
});

describe("momentum at the buy", () => {
  const realFetch = globalThis.fetch;
  const realRandom = Math.random;
  beforeEach(() => {
    Math.random = () => 0.5;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    Math.random = realRandom;
  });

  /** DexScreener answering with the curve at `overStartPct` above its start. */
  function curveAt(overStartPct: number) {
    const priceNative = String(PUMPFUN_START_PRICE_SOL * (1 + overStartPct / 100));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ dexId: "pumpfun", priceNative, pairAddress: "x" }]))) as typeof fetch;
  }

  function liveTrader() {
    const added: Position[] = [];
    let quoted = 0;
    const store = { count: () => added.length, list: () => added, add: (p: Position) => added.push(p) } as unknown as PositionStore;
    const pnl = { buildSnapshot: () => ({ openExposureUsd: 0, balanceUsd: 10_000 }) } as unknown as PnlTracker;
    const circuit = { canTrade: () => ({ allowed: true }) } as unknown as DrawdownCircuit;
    const feed = {
      entryQuote: async () => {
        quoted++;
        return { ok: true, priceUsd: 1, liquidityUsd: 100_000, premiumPct: 3 };
      },
    } as unknown as MarketFeed;
    const trader = new Trader(store, pnl, circuit, feed);
    trader.setEnabled(true);
    return { trader, added, quoted: () => quoted };
  }

  const pumpPool = (mint: string) =>
    ({ poolAddress: mint, tokenMint: mint, source: "pumpfun", initialPriceUsd: 0.000003, initialLiquidityUsd: 5400, detectedAt: 0 }) as PoolEvent;

  test("a curve that slid back under the minimum since its verdict is not bought", async () => {
    curveAt(5);
    const { trader, added, quoted } = liveTrader();
    await trader.handleVerdict({ ...verdict, poolAddress: "Faded1" }, pumpPool("Faded1"));
    assert.equal(added.length, 0);
    assert.equal(quoted(), 0, "rejected before the entry quote");
    assert.equal(trader.getStats().skippedFaded, 1);
  });

  test("a curve still above the minimum is bought", async () => {
    curveAt(30);
    const { trader, added } = liveTrader();
    await trader.handleVerdict({ ...verdict, poolAddress: "Rising1" }, pumpPool("Rising1"));
    assert.equal(added.length, 1);
    assert.equal(trader.getStats().skippedFaded, 0);
  });
});

describe("entry price from the curve", () => {
  const realRandom = Math.random;
  const realCurveState = launchTracker.curveState.bind(launchTracker);
  beforeEach(() => {
    Math.random = () => 0.5;
  });
  afterEach(() => {
    Math.random = realRandom;
    launchTracker.curveState = realCurveState;
  });

  function trader(jupiter: EntryQuote) {
    const added: Position[] = [];
    let quoted = 0;
    const store = { count: () => added.length, list: () => added, add: (p: Position) => added.push(p) } as unknown as PositionStore;
    const pnl = { buildSnapshot: () => ({ openExposureUsd: 0, balanceUsd: 10_000 }) } as unknown as PnlTracker;
    const circuit = { canTrade: () => ({ allowed: true }) } as unknown as DrawdownCircuit;
    const feed = {
      solPriceUsd: async () => 100,
      entryQuote: async () => {
        quoted++;
        return jupiter;
      },
    } as unknown as MarketFeed;
    const t = new Trader(store, pnl, circuit, feed);
    t.setEnabled(true);
    return { t, added, quoted: () => quoted };
  }
  const pool = { poolAddress: "C1", tokenMint: "C1", source: "pumpfun", initialPriceUsd: 0.000003, initialLiquidityUsd: 5400, detectedAt: 0 } as PoolEvent;

  test("a fresh curve prices the buy itself, so a lagging Jupiter index cannot refuse it", async () => {
    launchTracker.curveState = () => ({ virtualSolLamports: 60_000_000_000n, virtualTokenRaw: 536_500_000_000_000n, at: Date.now(), complete: false });
    const { t, added, quoted } = trader({ ok: false, reason: "price index and a real buy disagree by 34%" });
    await t.handleVerdict({ ...verdict, poolAddress: "C1" }, pool);
    assert.equal(quoted(), 0);
    assert.equal(added.length, 1);
    // a curve at 60 SOL / 536.5M tokens trades at ~$0.0000112 at $100 a SOL
    assert.ok(added[0]!.entryPriceUsd > 0.0000112 && added[0]!.entryPriceUsd < 0.0000125);
  });

  test("a curve last traded long ago falls back to Jupiter", async () => {
    launchTracker.curveState = () => ({ virtualSolLamports: 60_000_000_000n, virtualTokenRaw: 536_500_000_000_000n, at: Date.now() - 60_000, complete: false });
    const { t, quoted } = trader({ ok: false, reason: "no market price" });
    await t.handleVerdict({ ...verdict, poolAddress: "C1" }, pool);
    assert.equal(quoted(), 1);
  });
});
