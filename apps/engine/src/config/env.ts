import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const tpLadderSchema = z
  .string()
  .regex(/^(\d+(\.\d+)?:\d+(\.\d+)?)(,\d+(\.\d+)?:\d+(\.\d+)?)*$/, {
    message: "TP_LADDER must be like '50:25,100:25,300:25,900:15' (gain%:sellPct)",
  })
  .transform((s) =>
    s.split(",").map((entry) => {
      const [gain, sell] = entry.split(":");
      return { gainPct: Number(gain), sellPct: Number(sell) };
    }),
  );

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
  // prices for paper trades: entries, exits and the rug watch
  JUPITER_PRICE_API: z.string().url().default("https://lite-api.jup.ag/price/v3"),
  // seconds between a pool appearing and its filters running; 0 = at once
  EVAL_DELAY_SEC: z.coerce.number().int().min(0).default(90),
  // "delay": judge every pump.fun launch EVAL_DELAY_SEC after it appears.
  // "breakout": judge a launch the moment its curve first reaches
  // BREAKOUT_MULTIPLE × its start price on real buying; other DEXes keep the delay.
  ENTRY_MODE: z.enum(["delay", "breakout"]).default("delay"),
  BREAKOUT_MULTIPLE: z.coerce.number().min(1).default(2),
  BREAKOUT_MIN_AGE_SEC: z.coerce.number().min(0).default(5),
  BREAKOUT_MIN_BUY_SOL: z.coerce.number().min(0).default(22),
  BREAKOUT_MAX_DEV_SOLD_PCT: z.coerce.number().min(0).max(100).default(100),
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

  // Position sizing
  POSITION_SIZE_PCT: z.coerce.number().positive(),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive(),
  MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().positive().max(100),
  MAX_POSITION_PER_MIN: z.coerce.number().int().positive(),

  // Exits
  TP_LADDER: tpLadderSchema,
  STOP_LOSS_PCT: z.coerce.number().negative(),
  TRAILING_STOP_PCT: z.coerce.number().positive(),
  TRAILING_STOP_ACTIVATION_PCT: z.coerce.number().positive(),
  // after TP1 the stop moves to the entry price
  BREAKEVEN_AFTER_TP1: boolFromString.default(true),
  // sell whatever is left this many minutes after the buy, win or lose; 0 = off
  HARD_EXIT_MIN: z.coerce.number().min(0).default(0),
  // a pump.fun position back at its curve's start price this long is sold; 0 = off
  DEAD_COIN_EXIT_MIN: z.coerce.number().min(0).default(3),
  DEAD_COIN_MAX_GAIN_PCT: z.coerce.number().min(0).default(2),
  TIME_EXIT_MIN: z.coerce.number().positive(),
  RUG_DETECTION_LP_DROP_PCT: z.coerce.number().positive().max(100),

  // Risk
  DAILY_DRAWDOWN_LIMIT_PCT: z.coerce.number().positive().max(100),
  WEEKLY_DRAWDOWN_LIMIT_PCT: z.coerce.number().positive().max(100),
  HALT_ON_CONSECUTIVE_LOSSES: z.coerce.number().int().positive(),

  // Filters
  FILTER_LIQUIDITY_MIN_USD: z.coerce.number().nonnegative(),
  FILTER_LIQUIDITY_MAX_USD: z.coerce.number().positive(),
  FILTER_LP_LOCKED_REQUIRED: boolFromString,
  FILTER_MINT_AUTH_RENOUNCED: boolFromString,
  FILTER_FREEZE_AUTH_RENOUNCED: boolFromString,
  FILTER_TOP_HOLDER_MAX_PCT: z.coerce.number().positive().max(100),
  FILTER_TOP_10_HOLDERS_MAX_PCT: z.coerce.number().positive().max(100),
  FILTER_DEV_RUG_RATE_MAX: z.coerce.number().min(0).max(1),
  FILTER_HONEYPOT_SIM_REQUIRED: boolFromString,
  FILTER_MAX_SELL_TAX_PCT: z.coerce.number().min(0).max(100),
  FILTER_BUNDLED_LAUNCH_REJECT: boolFromString,
  // % of supply the launch-slot buyers (dev excluded) may still hold
  FILTER_BUNDLE_MAX_SUPPLY_PCT: z.coerce.number().min(0).max(100).default(15),
  // % of their own buy the dev may already have sold
  FILTER_DEV_MAX_SOLD_PCT: z.coerce.number().min(0).max(100).default(50),
  // % a pump.fun price must sit over its launch price (after the dev's buy)
  FILTER_CURVE_GAIN_MIN_PCT: z.coerce.number().min(0).default(20),
  FILTER_MIN_FILTER_SCORE: z.coerce.number().min(0).max(100),
  // Narrative filter (score from apps/narrative via Redis key narrative:<mint>).
  // "shadow": recorded only, never rejects and never moves the score.
  // "gate": rejects below NARRATIVE_MIN_SCORE and counts with NARRATIVE_FILTER_WEIGHT.
  NARRATIVE_FILTER_MODE: z.enum(["shadow", "gate"]).default("shadow"),
  NARRATIVE_FILTER_WEIGHT: z.coerce.number().min(0).default(0),
  NARRATIVE_MIN_SCORE: z.coerce.number().min(0).max(100).default(50),

  // Execution
  JITO_TIP_LAMPORTS: z.coerce.number().int().nonnegative(),
  JITO_TIP_DYNAMIC: boolFromString,
  SLIPPAGE_BPS: z.coerce.number().int().nonnegative(),
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative(),

  // DEX sources
  ENABLE_PUMPFUN: boolFromString,
  // pump.fun launches dropped before any filter or RPC call
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
  ALERT_ON_DRAWDOWN_HALT: boolFromString.default(true),
  ALERT_ON_ENGINE_STATUS: boolFromString.default(true),
  ALERT_DAILY_PNL_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(0),

  // Runtime
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ENGINE_HTTP_PORT: z.coerce.number().int().positive().default(4000),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),

  // Synthetic feed (for testing pipeline without a Helius key)
  SYNTHETIC_FEED: boolFromString.default(false),
  SYNTHETIC_FEED_MIN_MS: z.coerce.number().int().positive().default(2000),
  SYNTHETIC_FEED_MAX_MS: z.coerce.number().int().positive().default(5000),
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
