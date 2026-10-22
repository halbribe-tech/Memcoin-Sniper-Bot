import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/** Repo root: apps/narrative/src → ../../.. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Same .env as the engine: the one in this folder if there is one, else the repo root's.
for (const p of [resolve(process.cwd(), ".env"), resolve(REPO_ROOT, "apps/narrative/.env"), resolve(REPO_ROOT, ".env")]) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const schema = z.object({
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // How long narrative:<mint> lives in Redis
  NARRATIVE_TTL_SEC: z.coerce.number().int().positive().default(1800),

  // Meta list sources (merged; see apps/narrative/README.md for the schema)
  NARRATIVE_METAS_FILE: z.string().default("apps/narrative/data/metas.json"),
  NARRATIVE_METAS_URL: z.string().default(""),
  NARRATIVE_METAS_URL_TOKEN: z.string().default(""),
  NARRATIVE_METAS_POLL_SEC: z.coerce.number().int().min(30).default(300),
  // a theme's weight halves every this many hours after its firstSeen (floor 0.35)
  NARRATIVE_FRESHNESS_HALFLIFE_H: z.coerce.number().positive().default(24),

  // Self-sourced fallback: recent winners from the bot's own Postgres data
  NARRATIVE_SELF_SOURCE: bool.default(true),
  NARRATIVE_SELF_LOOKBACK_H: z.coerce.number().positive().default(6),
  NARRATIVE_SELF_MIN_GAIN_PCT: z.coerce.number().min(0).default(100),
  NARRATIVE_SELF_REFRESH_SEC: z.coerce.number().int().min(30).default(300),

  // Saturation: launches on one theme within the last hour before a penalty starts
  NARRATIVE_SATURATION_FREE: z.coerce.number().int().min(0).default(8),

  // Metadata JSON fetch (description + socials)
  NARRATIVE_METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  NARRATIVE_METADATA_CONCURRENCY: z.coerce.number().int().positive().default(16),

  // LLM, any OpenAI-compatible /chat/completions endpoint; off while the key is empty
  NARRATIVE_LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  NARRATIVE_LLM_API_KEY: z.string().default(""),
  NARRATIVE_LLM_MODEL: z.string().default(""),
  NARRATIVE_LLM_MIN_FAST_SCORE: z.coerce.number().min(0).max(100).default(45),
  NARRATIVE_LLM_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),
  NARRATIVE_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  NARRATIVE_LLM_MAX_PER_MIN: z.coerce.number().int().positive().default(20),
  NARRATIVE_LLM_CONCURRENCY: z.coerce.number().int().positive().default(3),
});

export type NarrativeEnv = z.infer<typeof schema>;

function load(): NarrativeEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid narrative env:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export function repoPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

export const llmEnabled = env.NARRATIVE_LLM_API_KEY !== "" && env.NARRATIVE_LLM_MODEL !== "";
