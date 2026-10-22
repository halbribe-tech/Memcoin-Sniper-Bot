import type { CurveState } from "../feeds/launch-tracker.js";

// pump.fun's fee on a curve trade (protocol + creator), taken from the SOL paid in
export const PUMP_CURVE_FEE = 0.0125;

/**
 * What a buy of `sizeUsd` pays on a pump.fun curve, from its virtual reserves:
 * constant product, fee off the SOL going in. Exact where Jupiter's price
 * index lags a curve that has just doubled — two breakout entries were
 * refused when the index and the quote disagreed by 34% and -21%.
 */
export function curveBuyQuote(
  curve: Pick<CurveState, "virtualSolLamports" | "virtualTokenRaw">,
  sizeUsd: number,
  solUsd: number,
): { priceUsd: number; liquidityUsd: number } | null {
  const virtualSol = Number(curve.virtualSolLamports) / 1e9;
  const virtualTokens = Number(curve.virtualTokenRaw) / 1e6;
  if (!(virtualSol > 0 && virtualTokens > 0 && solUsd > 0 && sizeUsd > 0)) return null;
  const solIn = (sizeUsd / solUsd) * (1 - PUMP_CURVE_FEE);
  const tokensOut = virtualTokens - (virtualSol * virtualTokens) / (virtualSol + solIn);
  if (!(tokensOut > 0)) return null;
  return { priceUsd: sizeUsd / tokensOut, liquidityUsd: virtualSol * solUsd };
}
