import type { PoolEvent } from "@sniperbot/shared";
import type { Filter } from "./types.js";
import { makeResult } from "./types.js";
import { fetchPair } from "../feeds/dexscreener-client.js";
import {
  PUMPFUN_VIRTUAL_SOL_RESERVES,
  PUMPFUN_VIRTUAL_TOKEN_RESERVES,
} from "../feeds/parsers/pumpfun.js";

/** Every pump.fun curve opens at this price in SOL, so any gain over it is net buying. */
export const PUMPFUN_START_PRICE_SOL = PUMPFUN_VIRTUAL_SOL_RESERVES / PUMPFUN_VIRTUAL_TOKEN_RESERVES;

/** How far the curve's price sits above where it started, in percent. */
export function curveGainPct(priceNative: number, startPriceSol = PUMPFUN_START_PRICE_SOL): number {
  return (priceNative / startPriceSol - 1) * 100;
}

/** The start price read from the launch's CreateEvent; the standard curve's when it was not. */
function startPriceSol(pool: PoolEvent): number {
  const start = (pool.rawEvent as { curveStartPriceSol?: unknown } | undefined)?.curveStartPriceSol;
  return typeof start === "number" && start > 0 ? start : PUMPFUN_START_PRICE_SOL;
}

/**
 * Rejects a pump.fun launch whose price has not left the curve's start. Buys
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

    const pair = await fetchPair(pool.tokenMint);
    const priceNative = Number(pair?.priceNative);
    // after migration the best pair is the AMM pool, whose price says nothing about the curve
    if (!pair || pair.dexId !== "pumpfun" || !Number.isFinite(priceNative) || priceNative <= 0) {
      return makeResult("curve-momentum", "skip", "no pump.fun curve price on DexScreener yet", {
        durationMs: Date.now() - start,
      });
    }

    const gainPct = curveGainPct(priceNative, startPriceSol(pool));
    const metadata = { priceNative, gainPct, min };
    if (gainPct < min) {
      return makeResult(
        "curve-momentum",
        "fail",
        `price ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}% over curve start < min +${min}% — no net buying since launch`,
        { metadata, durationMs: Date.now() - start },
      );
    }
    return makeResult(
      "curve-momentum",
      "pass",
      `price +${gainPct.toFixed(1)}% over curve start ≥ min +${min}%`,
      { metadata, durationMs: Date.now() - start },
    );
  },
};
