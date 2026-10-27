export type TradeSide = "buy" | "sell";
export type TradeStatus = "filled" | "failed" | "partial";
/** Why a sale happened, in the strategy's own words (e.g. "take-profit", "stop-loss"). */
export type ExitReason = string;

export interface Trade {
  id: string;
  positionId: string;
  side: TradeSide;
  status: TradeStatus;
  priceUsd: number;
  amountTokens: number;
  amountUsd: number;
  feeSol: number;
  slippagePct: number;
  mevPenaltyPct?: number;
  exitReason?: ExitReason;
  signature?: string;
  executedAt: number;
}
