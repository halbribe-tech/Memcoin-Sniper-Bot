import { randomUUID } from "node:crypto";
import type { PoolEvent, Position } from "@sniperbot/shared";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { PositionStore } from "../state/position-store.js";
import { paperExecutor, buyResultToTrade, sellResultToTrade, type EntryMarket } from "./paper-executor.js";
import type { MarketFeed } from "./market-price.js";
import { launchTracker } from "../feeds/launch-tracker.js";
import { curveBuyQuote } from "./curve-quote.js";

const log = childLogger("broker");

// a curve last traded this long ago may have moved; ask Jupiter instead
const CURVE_FRESH_MS = 30_000;

/**
 * Carries out the strategy's orders on paper: prices a buy the way a real one
 * would fill, opens and sells positions. It decides nothing beyond what makes
 * an order impossible: trading switched off, the coin already held, no price,
 * a sold-out curve.
 */
export class PaperBroker {
  private readonly store: PositionStore;
  private readonly feed: MarketFeed;
  private enabled = false;
  // mints being bought right now; with the open positions, a coin is held at most once
  private readonly buying = new Set<string>();
  private stats = { buys: 0, sells: 0, failedFills: 0, noPrice: 0 };

  constructor(store: PositionStore, feed: MarketFeed) {
    this.store = store;
    this.feed = feed;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    log.warn(on ? "trading STARTED from dashboard" : "trading STOPPED from dashboard");
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** A buy is waiting for its price; the stats reset waits for it. */
  isBuying(): boolean {
    return this.buying.size > 0;
  }

  holds(mint: string): boolean {
    return this.buying.has(mint) || this.store.list().some((p) => p.tokenMint === mint);
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { buys: 0, sells: 0, failedFills: 0, noPrice: 0 };
  }

  /** Open a paper position of `sizeUsd`; null when it could not be bought. */
  async buy(pool: PoolEvent, sizeUsd: number): Promise<Position | null> {
    if (!this.enabled || !(sizeUsd > 0) || this.holds(pool.tokenMint)) return null;
    this.buying.add(pool.tokenMint);
    try {
      return await this.open(pool, sizeUsd);
    } catch (err) {
      log.error({ err, mint: pool.tokenMint.slice(0, 8) }, "buy failed");
      return null;
    } finally {
      this.buying.delete(pool.tokenMint);
    }
  }

  /** Sell `fraction` of the tokens a position still holds, at `priceUsd`. */
  sell(positionId: string, fraction: number, reason: string, priceUsd: number, liquidityUsd: number): void {
    const p = this.store.get(positionId)?.position;
    if (!p || !(fraction > 0) || !(priceUsd > 0)) return;
    const whole = fraction >= 0.999;
    const tokens = whole ? p.remainingTokens : p.remainingTokens * Math.min(1, fraction);
    const result = paperExecutor.sell(p.entryPriceUsd, priceUsd, tokens, liquidityUsd, reason);
    const trade = sellResultToTrade(p.id, result);
    this.stats.sells++;
    if (whole) this.store.closeFully(p.id, result.proceedsUsd, trade, reason);
    else this.store.applyPartialSell(p.id, result.tokensSold, result.proceedsUsd, trade);
  }

  private async open(pool: PoolEvent, sizeUsd: number): Promise<Position | null> {
    if (pool.source === "pumpfun" && launchTracker.curveState(pool.tokenMint)?.complete) {
      log.info({ mint: pool.tokenMint.slice(0, 8) }, "curve already complete — cannot buy it on the curve");
      return null;
    }
    let market = await this.curveEntry(pool, sizeUsd);
    if (!market) {
      // Enter at what a real buy of this size would pay, and only when the
      // price index agrees — an index 114× too high once cost a whole position.
      const entry = await this.feed.entryQuote(pool.tokenMint, sizeUsd);
      if (!entry.ok) {
        this.stats.noPrice++;
        log.warn({ mint: pool.tokenMint.slice(0, 8), reason: entry.reason }, "no trustworthy entry price — not buying");
        return null;
      }
      market = { priceUsd: entry.priceUsd, liquidityUsd: entry.liquidityUsd, priceIncludesImpact: true };
    }
    // switched off while the price was being fetched
    if (!this.enabled) return null;

    const result = paperExecutor.buy(pool, sizeUsd, market);
    if (result.status === "failed") {
      this.stats.failedFills++;
      return null;
    }
    const position: Position = {
      id: randomUUID(),
      poolAddress: pool.poolAddress,
      tokenMint: pool.tokenMint,
      tokenSymbol: pool.token?.symbol,
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
      openedAt: result.fillTime,
      status: "open",
    };
    this.store.add(position, buyResultToTrade(position.id, result));
    this.stats.buys++;
    return position;
  }

  /**
   * A pump.fun buy priced off the curve itself, from the reserves after the
   * last trade the stream saw; null when there is no fresh curve to read.
   */
  private async curveEntry(pool: PoolEvent, sizeUsd: number): Promise<EntryMarket | null> {
    if (pool.source !== "pumpfun") return null;
    const curve = launchTracker.curveState(pool.tokenMint);
    if (!curve || Date.now() - curve.at > CURVE_FRESH_MS) return null;
    const solUsd = await this.feed.solPriceUsd();
    const quote = solUsd ? curveBuyQuote(curve, sizeUsd, solUsd) : null;
    return quote ? { ...quote, priceIncludesImpact: true } : null;
  }
}
