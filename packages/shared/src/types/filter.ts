export type FilterId =
  | "liquidity-min"
  | "lp-locked"
  | "mint-authority"
  | "freeze-authority"
  | "top-holders"
  | "dev-wallet"
  | "bundled-launch"
  | "insider-detection"
  | "honeypot-sim"
  | "social-signal"
  | "volume-velocity"
  | "anti-sniper-war"
  | "curve-momentum";

export const FILTER_LABELS: Record<FilterId, string> = {
  "liquidity-min": "Liquidity",
  "lp-locked": "LP Locked",
  "mint-authority": "Mint Auth",
  "freeze-authority": "Freeze Auth",
  "top-holders": "Top Holders",
  "dev-wallet": "Dev History",
  "bundled-launch": "Bundle Check",
  "insider-detection": "Insider",
  "honeypot-sim": "Honeypot",
  "social-signal": "Social",
  "volume-velocity": "Volume",
  "anti-sniper-war": "Sniper War",
  "curve-momentum": "Momentum",
};

export const FILTER_ORDER: FilterId[] = [
  "honeypot-sim",
  "lp-locked",
  "mint-authority",
  "freeze-authority",
  "dev-wallet",
  "top-holders",
  "liquidity-min",
  "bundled-launch",
  "insider-detection",
  "anti-sniper-war",
  "curve-momentum",
  "volume-velocity",
  "social-signal",
];

/**
 * Off unless a preset or the Filters page turns them on. anti-sniper-war
 * counts transactions among a coin's newest signatures, not its first block,
 * so it measures how busy a coin is right now and rejected the busiest: in
 * one hour of verdicts all four that rose 500%+ after being judged, and 8 of
 * the 9 that reached TP1.
 */
export const FILTERS_OFF_BY_DEFAULT: readonly FilterId[] = ["anti-sniper-war"];

export function filterOnByDefault(id: FilterId): boolean {
  return !FILTERS_OFF_BY_DEFAULT.includes(id);
}

export type FilterStatus = "pass" | "fail" | "skip" | "error";

export interface FilterResult {
  filterId: FilterId;
  status: FilterStatus;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
  evaluatedAt: number;
  durationMs: number;
}

export type Decision = "snipe" | "reject";

export interface OrchestratorVerdict {
  poolAddress: string;
  signature: string;
  source: string;
  totalScore: number;
  maxScore: number;
  passedCount: number;
  failedCount: number;
  decision: Decision;
  decisionReason: string;
  results: FilterResult[];
  decidedAt: number;
  totalDurationMs: number;
}
