export type DexSource =
  | "pumpfun"
  | "pumpswap"
  | "raydium-amm"
  | "raydium-clmm"
  | "raydium-launchpad"
  | "meteora"
  | "orca";

/** What the launch said about its coin: name, ticker and where its metadata (with the image) lives. */
export interface TokenInfo {
  name?: string;
  symbol?: string;
  metadataUri?: string;
}

export interface PoolEvent {
  poolAddress: string;
  tokenMint: string;
  baseMint: string;
  source: DexSource;
  initialLiquidityUsd: number;
  initialPriceUsd: number;
  creatorWallet: string;
  detectedAt: number;
  signature: string;
  token?: TokenInfo;
  rawEvent?: unknown;
}

/** What the strategy decided about a pool, for the dashboard's feed and the database. */
export interface PoolDecision {
  poolAddress: string;
  tokenMint: string;
  signature: string;
  source: DexSource;
  decision: "buy" | "skip";
  /** free text from the strategy */
  reason: string;
  decidedAt: number;
}
