export interface BucketPerformance {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUsd: number;
}

export type StatsWindowKey = "10m" | "30m" | "1h" | "6h" | "24h" | "7d" | "all";

export interface TradeHighlight {
  positionId: string;
  tokenMint: string;
  tokenSymbol: string | null;
  source: string;
  entrySizeUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  peakGainPct: number;
  closeReason: string | null;
  closedAt: number;
}

export interface BankrollPoint {
  ts: number;
  balanceUsd: number;
  realizedPnlUsd: number;
  openExposureUsd: number;
}

export interface TradeStatsWindow {
  windowKey: StatsWindowKey;
  windowMs: number;
  fromTs: number;
  toTs: number;
  // Activity counts
  positionsOpenedInWindow: number;
  positionsClosedInWindow: number;
  // Money flow (closed positions in window)
  investedUsd: number;
  realizedPnlUsd: number;
  totalGrossWinUsd: number;
  totalGrossLossUsd: number;
  // Performance
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  roiPct: number;
  // Breakdowns
  byDex: BucketPerformance[];
  byCloseReason: BucketPerformance[];
  // Highlights
  topWinner: TradeHighlight | null;
  topLoser: TradeHighlight | null;
  // Series
  bankrollSeries: BankrollPoint[];
  takenAt: number;
}
