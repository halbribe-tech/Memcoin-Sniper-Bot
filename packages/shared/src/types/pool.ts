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
