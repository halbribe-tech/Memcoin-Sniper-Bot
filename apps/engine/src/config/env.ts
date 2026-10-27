import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const envSchema = z.object({
  // Mode
  MODE: z.enum(["paper", "live"]).default("paper"),
  ENABLE_LIVE_TRADING: boolFromString.default(false),

  // Solana RPC
  HELIUS_API_KEY: z.string().default(""),
  HELIUS_RPC_URL: z.string().url(),
  HELIUS_WS_URL: z.string().startsWith("wss://"),
  TRITON_RPC_URL: z.string().optional().default(""),
  JITO_BLOCK_ENGINE_URL: z.string().url(),
  PUBLIC_SOLANA_RPC: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_MAX_RPS: z.coerce.number().int().positive().default(8),
  // quote-api.jup.ag/v6 no longer answers; lite-api is the keyless successor
  JUPITER_QUOTE_API: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  // prices for paper trades: entries and open positions
  JUPITER_PRICE_API: z.string().url().default("https://lite-api.jup.ag/price/v3"),
  RUGCHECK_API_BASE: z.string().url().default("https://api.rugcheck.xyz/v1"),

  // Data APIs
  BIRDEYE_API_KEY: z.string().optional().default(""),
  BITQUERY_API_KEY: z.string().optional().default(""),
  RUGCHECK_API_KEY: z.string().optional().default(""),
  DEXSCREENER_BASE: z.string().url(),
  GECKOTERMINAL_BASE: z.string().url(),

  // Wallet
  SOLANA_KEYPAIR_PATH: z.string().optional().default(""),
  WALLET_PUBKEY: z.string().optional().default(""),

  // Bankroll
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive(),
  LIVE_MAX_BANKROLL_USD: z.coerce.number().positive(),

  // Execution
  JITO_TIP_LAMPORTS: z.coerce.number().int().nonnegative(),
  JITO_TIP_DYNAMIC: boolFromString,
  SLIPPAGE_BPS: z.coerce.number().int().nonnegative(),
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative(),

  // DEX sources
  ENABLE_PUMPFUN: boolFromString,
  // pump.fun launches the detector drops before the strategy sees them
  PUMPFUN_SKIP_MAYHEM: boolFromString.default(true),
  PUMPFUN_SOL_PAIRS_ONLY: boolFromString.default(true),
  ENABLE_PUMPSWAP: boolFromString,
  ENABLE_RAYDIUM_AMM: boolFromString,
  ENABLE_RAYDIUM_CLMM: boolFromString,
  ENABLE_RAYDIUM_LAUNCHPAD: boolFromString,
  ENABLE_METEORA: boolFromString,
  ENABLE_ORCA: boolFromString,

  // Infra
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  // Alerts
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  ALERT_ON_NEW_POSITION: boolFromString.default(true),
  ALERT_ON_EXIT: boolFromString.default(true),
  ALERT_ON_DAILY_PNL: boolFromString.default(true),
  ALERT_ON_ENGINE_STATUS: boolFromString.default(true),
  ALERT_DAILY_PNL_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(0),

  // Runtime
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ENGINE_HTTP_PORT: z.coerce.number().int().positive().default(4000),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[env] Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (parsed.data.MODE === "live" && !parsed.data.ENABLE_LIVE_TRADING) {
    console.error("[env] MODE=live but ENABLE_LIVE_TRADING=false. Refusing to start.");
    process.exit(1);
  }

  if (parsed.data.MODE === "live" && !parsed.data.SOLANA_KEYPAIR_PATH) {
    console.error("[env] MODE=live requires SOLANA_KEYPAIR_PATH.");
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isPaperMode = env.MODE === "paper";
export const isLiveMode = env.MODE === "live";
