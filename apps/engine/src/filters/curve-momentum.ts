import type { PoolEvent } from "@sniperbot/shared";
import type { Filter } from "./types.js";
import { makeResult } from "./types.js";
import { fetchPair, invalidate } from "../feeds/dexscreener-client.js";
import { PUMPFUN_START_PRICE_SOL } from "../feeds/parsers/pumpfun.js";

export { PUMPFUN_START_PRICE_SOL };

/** How far the curve's price sits above where it started, in percent. */
export function curveGainPct(priceNative: number, startPriceSol = PUMPFUN_START_PRICE_SOL): number {
  return (priceNative / startPriceSol - 1) * 100;
}

/**
 * The price momentum is measured from: the curve after the dev's own buy in
 * the create transaction, else the curve's start, else the standard curve's.
 */
function startPriceSol(pool: PoolEvent): number {
  const raw = pool.rawEvent as { launchPriceSol?: unknown; curveStartPriceSol?: unknown } | undefined;
  for (const v of [raw?.launchPriceSol, raw?.curveStartPriceSol]) {
    if (typeof v === "number" && v > 0) return v;
  }
  return PUMPFUN_START_PRICE_SOL;
}

/**
 * The curve's price on DexScreener and its gain over the curve's start, or
 * null when DexScreener has no curve price. `fresh` skips the 15s cache.
 */
export async function curveGainNow(
  pool: PoolEvent,
  fresh = false,
): Promise<{ priceNative: number; gainPct: number } | null> {
  if (fresh) invalidate(pool.tokenMint);
  const pair = await fetchPair(pool.tokenMint);
  const priceNative = Number(pair?.priceNative);
  // after migration the best pair is the AMM pool, whose price says nothing about the curve
  if (!pair || pair.dexId !== "pumpfun" || !Number.isFinite(priceNative) || priceNative <= 0) return null;
  return { priceNative, gainPct: curveGainPct(priceNative, startPriceSol(pool)) };
}

/**
 * Rejects a pump.fun launch whose price has not risen past its launch price,
 * taken after the dev's own buy in the create transaction. Buys
 * and sells can both be busy while cancelling out: one token showed 34 buys
 * and 21 sells in five minutes and still sat at its launch price, so a $100
 * entry, which pays ~3.6% over the mark, began in a drawdown it never left.
 * The price comes from the DexScreener pair volume-velocity already fetches
 * (cached), so this costs no RPC credits.
 */
export const curveMomentumFilter: Filter = {
  id: "curve-momentum",
  weight: 6,
  enabled: true,
  async evaluate(pool, ctx) {
    const start = Date.now();
    const min = ctx.cfg.curveGainMinPct;

    if (pool.source !== "pumpfun" || ctx.isSynthetic) {
      return makeResult("curve-momentum", "skip", "not a live pump.fun bonding curve", {
        durationMs: Date.now() - start,
      });
    }

    const now = await curveGainNow(pool);
    if (!now) {
      return makeResult("curve-momentum", "skip", "no pump.fun curve price on DexScreener yet", {
        durationMs: Date.now() - start,
      });
    }

    const { priceNative, gainPct } = now;
    const metadata = { priceNative, gainPct, min };
    if (gainPct < min) {
      return makeResult(
        "curve-momentum",
        "fail",
        `price ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}% over launch (after the dev's buy) < min +${min}% — no net buying since`,
        { metadata, durationMs: Date.now() - start },
      );
    }
    return makeResult(
      "curve-momentum",
      "pass",
      `price +${gainPct.toFixed(1)}% over launch (after the dev's buy) ≥ min +${min}%`,
      { metadata, durationMs: Date.now() - start },
    );
  },
};
