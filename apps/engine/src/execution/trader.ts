import { randomUUID } from "node:crypto";
import type { OrchestratorVerdict, PoolEvent, Position } from "@sniperbot/shared";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { buildTPLadder, PositionStore } from "../state/position-store.js";
import { paperExecutor, buyResultToTrade, type EntryMarket } from "./paper-executor.js";
import { buildProfile, isSyntheticPool } from "./price-simulator.js";
import type { MarketFeed } from "./market-price.js";
import type { PnlTracker } from "../analytics/pnl-tracker.js";
import type { DrawdownCircuit } from "../risk/drawdown-circuit.js";
import { filterConfig } from "../config/filter-config.js";
import { curveGainNow } from "../filters/curve-momentum.js";
import { launchTracker } from "../feeds/launch-tracker.js";
import { curveBuyQuote } from "./curve-quote.js";

const log = childLogger("trader");

// a curve last traded this long ago may have moved; ask Jupiter instead
const CURVE_FRESH_MS = 30_000;

export class Trader {
  private readonly store: PositionStore;
  private readonly pnl: PnlTracker;
  private readonly circuit: DrawdownCircuit;
  private readonly feed: MarketFeed | null;
  private readonly recentEntries: number[] = [];
  // entries past every check, waiting for their market price
  private pendingEntries = 0;
  // mints being bought right now; with the open positions, a coin is held at most once
  private readonly enteringMints = new Set<string>();
  private skippedFull = 0;
  private skippedRate = 0;
  private skippedExposure = 0;
  private skippedHalted = 0;
  private skippedDisabled = 0;
  private skippedNoPrice = 0;
  private skippedFaded = 0;
  private failedFills = 0;
  // Off at every start: nothing opens until someone presses Start on the dashboard.
  private enabled = false;

  private readonly recentPools = new Map<string, { pool: PoolEvent; cachedAt: number }>();

  constructor(store: PositionStore, pnl: PnlTracker, circuit: DrawdownCircuit, feed: MarketFeed | null = null) {
    this.store = store;
    this.pnl = pnl;
    this.circuit = circuit;
    this.feed = feed;
  }

  cachePool(pool: PoolEvent): void {
    this.recentPools.set(pool.poolAddress, { pool, cachedAt: Date.now() });
    // Every verdict takes its pool out, so this only sweeps pools whose verdict
    // never came (the bot was switched off mid-evaluation). Filters can run for
    // 110s under rate limits; a 60s sweep dropped snipes still being judged.
    if (this.recentPools.size > 200) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [addr, rec] of this.recentPools) {
        if (rec.cachedAt < cutoff) this.recentPools.delete(addr);
      }
    }
  }

  /** Look up + drop the matching pool for a verdict. */
  resolvePool(verdict: OrchestratorVerdict): PoolEvent | null {
    const rec = this.recentPools.get(verdict.poolAddress);
    if (!rec) return null;
    this.recentPools.delete(verdict.poolAddress);
    return rec.pool;
  }

  /** A buy past every check is still waiting for its price. */
  isEntering(): boolean {
    return this.pendingEntries > 0;
  }

  resetStats(): void {
    this.recentPools.clear();
    this.recentEntries.length = 0;
    this.skippedFull = 0;
    this.skippedRate = 0;
    this.skippedExposure = 0;
    this.skippedHalted = 0;
    this.skippedDisabled = 0;
    this.skippedNoPrice = 0;
    this.skippedFaded = 0;
    this.failedFills = 0;
  }

  getStats() {
    return {
      skippedFull: this.skippedFull,
      skippedRate: this.skippedRate,
      skippedExposure: this.skippedExposure,
      skippedHalted: this.skippedHalted,
      skippedDisabled: this.skippedDisabled,
      skippedNoPrice: this.skippedNoPrice,
      skippedFaded: this.skippedFaded,
      failedFills: this.failedFills,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Gates new entries only. Open positions keep their exits either way —
   * stopping must never strand a position without its stop-loss.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    log.warn({ mode: env.MODE }, on ? "trading STARTED from dashboard" : "trading STOPPED from dashboard");
  }

  /**
   * Handle a snipe verdict — open a paper position if checks pass. A real pool
   * is bought at its market price at this moment; a pool nobody quotes is not
   * bought at all, since nothing could be known about the fill.
   */
  async handleVerdict(verdict: OrchestratorVerdict, pool: PoolEvent): Promise<void> {
    if (verdict.decision !== "snipe") return;

    if (!this.enabled) {
      this.skippedDisabled++;
      return;
    }

    const gate = this.circuit.canTrade();
    if (!gate.allowed) {
      this.skippedHalted++;
      log.warn({ reason: gate.reason, mint: pool.tokenMint.slice(0, 8) }, "circuit blocked snipe");
      return;
    }

    // copy mode can judge a coin twice: at its first copied wallet and again at the third
    if (this.enteringMints.has(pool.tokenMint) || this.store.list().some((p) => p.tokenMint === pool.tokenMint)) {
      log.info({ mint: pool.tokenMint.slice(0, 8) }, "already holding this coin — not buying it twice");
      return;
    }

    if (this.store.count() + this.pendingEntries >= env.MAX_CONCURRENT_POSITIONS) {
      this.skippedFull++;
      return;
    }

    // Rate limit: max N entries in 60s
    const now = Date.now();
    while (this.recentEntries.length && now - this.recentEntries[0]! > 60_000) {
      this.recentEntries.shift();
    }
    if (this.recentEntries.length >= env.MAX_POSITION_PER_MIN) {
      this.skippedRate++;
      log.warn({ limit: env.MAX_POSITION_PER_MIN }, "rate limit: skipping snipe");
      return;
    }

    const snap = this.pnl.buildSnapshot();
    const exposurePct = (snap.openExposureUsd / snap.balanceUsd) * 100;
    if (exposurePct >= env.MAX_TOTAL_EXPOSURE_PCT) {
      this.skippedExposure++;
      log.warn({ exposurePct: exposurePct.toFixed(1) }, "exposure cap: skipping snipe");
      return;
    }

    const sizeUsd = snap.balanceUsd * (env.POSITION_SIZE_PCT / 100);

    // Hold the slot while the price is fetched, so concurrent snipes cannot
    // all slip through the checks above; give it back if nothing opens.
    this.recentEntries.push(now);
    this.pendingEntries++;
    this.enteringMints.add(pool.tokenMint);
    let opened = false;
    try {
      opened = await this.open(verdict, pool, sizeUsd);
    } catch (err) {
      log.error({ err, mint: pool.tokenMint.slice(0, 8) }, "entry failed");
    } finally {
      this.pendingEntries--;
      this.enteringMints.delete(pool.tokenMint);
      if (!opened) {
        const i = this.recentEntries.lastIndexOf(now);
        if (i >= 0) this.recentEntries.splice(i, 1);
      }
    }
  }

  private async open(verdict: OrchestratorVerdict, pool: PoolEvent, sizeUsd: number): Promise<boolean> {
    const synthetic = isSyntheticPool(pool);
    if (!synthetic && (await this.fadedSinceVerdict(pool))) return false;
    // sold out while the filters ran: the curve takes no more buys
    if (pool.source === "pumpfun" && launchTracker.curveState(pool.tokenMint)?.complete) {
      log.info({ mint: pool.tokenMint.slice(0, 8) }, "curve completed before the buy — not trading it");
      return false;
    }
    let market: EntryMarket | undefined;
    if (!synthetic) {
      market = (await this.curveEntry(pool, sizeUsd)) ?? undefined;
      if (!market) {
        // Enter at what a real buy of this size would pay, and only when the
        // price index agrees — an index 114× too high once cost a whole position.
        const entry = this.feed
          ? await this.feed.entryQuote(pool.tokenMint, sizeUsd)
          : { ok: false as const, reason: "no market feed" };
        if (!entry.ok) {
          this.skippedNoPrice++;
          log.warn({ mint: pool.tokenMint.slice(0, 8), reason: entry.reason }, "no trustworthy entry price — not trading it");
          return false;
        }
        market = { priceUsd: entry.priceUsd, liquidityUsd: entry.liquidityUsd, priceIncludesImpact: true };
      }
    }
    if (!this.enabled) {
      // switched off while the price was being fetched
      this.skippedDisabled++;
      return false;
    }

    const result = paperExecutor.buy(verdict, pool, sizeUsd, market);
    if (result.status === "failed") {
      this.failedFills++;
      // Failed fills cost the fee — record as a tiny realized loss via a "ghost" closed position?
      // Simpler: just log for now; PnL only counts filled positions.
      return false;
    }

    const tokenSymbol = pool.token?.symbol ?? (pool.rawEvent as { name?: string } | undefined)?.name;
    const positionId = randomUUID();
    const position: Position = {
      id: positionId,
      poolAddress: pool.poolAddress,
      tokenMint: pool.tokenMint,
      tokenSymbol,
      tokenName: pool.token?.name,
      tokenMetadataUri: pool.token?.metadataUri,
      source: pool.source,
      mode: env.MODE,
      entryPriceUsd: result.effectivePriceUsd,
      entrySizeUsd: sizeUsd,
      initialTokens: result.tokensReceived,
      remainingTokens: result.tokensReceived,
      currentPriceUsd: result.effectivePriceUsd,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      realizedPnlUsd: 0,
      peakPriceUsd: result.effectivePriceUsd,
      peakGainPct: 0,
      tpLadder: buildTPLadder(env.TP_LADDER),
      stopLossPct: env.STOP_LOSS_PCT,
      trailingStopPct: env.TRAILING_STOP_PCT,
      trailingStopActivationPct: env.TRAILING_STOP_ACTIVATION_PCT,
      trailingStopArmed: false,
      timeExitMin: env.TIME_EXIT_MIN,
      filterScore: verdict.totalScore,
      openedAt: result.fillTime,
      status: "open",
    };

    // only a synthetic pool's price is simulated; a real one is priced by the feed
    const profile = synthetic ? buildProfile(pool, result.fillTime, result.effectivePriceUsd) : undefined;
    const buyTrade = buyResultToTrade(positionId, result);

    this.store.add(position, profile, buyTrade);
    return true;
  }

  /**
   * A pump.fun buy priced off the curve itself, from the reserves after the
   * last trade the stream saw; null when there is no fresh curve to read.
   */
  private async curveEntry(pool: PoolEvent, sizeUsd: number): Promise<EntryMarket | null> {
    if (pool.source !== "pumpfun" || !this.feed) return null;
    const curve = launchTracker.curveState(pool.tokenMint);
    if (!curve || Date.now() - curve.at > CURVE_FRESH_MS) return null;
    const solUsd = await this.feed.solPriceUsd();
    const quote = solUsd ? curveBuyQuote(curve, sizeUsd, solUsd) : null;
    return quote ? { ...quote, priceIncludesImpact: true } : null;
  }

  /**
   * The filters judged the curve a few seconds ago; by the buy it can have
   * slid back. Entries at +4% to +8% over the curve's start were bought from
   * verdicts that saw over +10%, and most of them fell to the floor.
   */
  private async fadedSinceVerdict(pool: PoolEvent): Promise<boolean> {
    const cfg = filterConfig.resolve();
    if (pool.source !== "pumpfun" || !cfg.enabled("curve-momentum")) return false;
    const now = await curveGainNow(pool, true);
    // no fresh price: the verdict's check stands
    if (!now || now.gainPct >= cfg.curveGainMinPct) return false;
    this.skippedFaded++;
    log.info(
      { mint: pool.tokenMint.slice(0, 8), gainPct: now.gainPct.toFixed(1), min: cfg.curveGainMinPct },
      "curve fell back below the minimum before the buy — not trading it",
    );
    return true;
  }
}
