import Redis from "ioredis";
import { narrativeKey, NEW_POOLS_CHANNEL, type PoolEvent } from "@sniperbot/shared";
import { env, llmEnabled, repoPath } from "./env.js";
import { logger } from "./logger.js";
import { MetaStore } from "./metas.js";
import { SelfSource, deriveSelfMetas } from "./self-source.js";
import { LlmJudge } from "./llm.js";
import { NarrativeService } from "./service.js";

async function main() {
  const metas = new MetaStore();
  const metasFile = env.NARRATIVE_METAS_FILE ? repoPath(env.NARRATIVE_METAS_FILE) : "";
  if (metasFile) metas.watchFile(metasFile);
  if (env.NARRATIVE_METAS_URL) metas.pollUrl(env.NARRATIVE_METAS_URL, env.NARRATIVE_METAS_POLL_SEC, env.NARRATIVE_METAS_URL_TOKEN);

  let self: SelfSource | null = null;
  let selfTimer: NodeJS.Timeout | null = null;
  if (env.NARRATIVE_SELF_SOURCE && env.DATABASE_URL) {
    self = new SelfSource(env.DATABASE_URL);
    const refresh = async () => {
      try {
        const rows = await self!.load(env.NARRATIVE_SELF_LOOKBACK_H, env.NARRATIVE_SELF_MIN_GAIN_PCT);
        const data = deriveSelfMetas(rows);
        metas.set("self", data);
        logger.info({ winners: rows.length, themes: data.themes.length }, "self-sourced metas refreshed");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "self-sourced metas failed (Postgres)");
      }
    };
    await refresh();
    selfTimer = setInterval(() => void refresh(), env.NARRATIVE_SELF_REFRESH_SEC * 1000);
  } else {
    logger.info("self-sourced metas off");
  }

  const llm = llmEnabled
    ? new LlmJudge({
        baseUrl: env.NARRATIVE_LLM_BASE_URL,
        apiKey: env.NARRATIVE_LLM_API_KEY,
        model: env.NARRATIVE_LLM_MODEL,
        timeoutMs: env.NARRATIVE_LLM_TIMEOUT_MS,
        maxPerMin: env.NARRATIVE_LLM_MAX_PER_MIN,
        concurrency: env.NARRATIVE_LLM_CONCURRENCY,
      })
    : null;
  logger.info(
    llm ? { model: env.NARRATIVE_LLM_MODEL, minFastScore: env.NARRATIVE_LLM_MIN_FAST_SCORE } : {},
    llm ? "LLM judgment on" : "LLM judgment off (NARRATIVE_LLM_API_KEY / NARRATIVE_LLM_MODEL empty)",
  );

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const sub = redis.duplicate();
  redis.on("error", (err) => logger.error({ err: err.message }, "redis error"));
  sub.on("error", (err) => logger.error({ err: err.message }, "redis (subscriber) error"));

  const service = new NarrativeService(
    metas,
    async (s) => {
      await redis.set(narrativeKey(s.mint), JSON.stringify(s), "EX", env.NARRATIVE_TTL_SEC);
    },
    {
      halfLifeH: env.NARRATIVE_FRESHNESS_HALFLIFE_H,
      saturationFree: env.NARRATIVE_SATURATION_FREE,
      copycatMaxAgeMs: env.NARRATIVE_SELF_LOOKBACK_H * 3600_000,
      metadataTimeoutMs: env.NARRATIVE_METADATA_TIMEOUT_MS,
      metadataConcurrency: env.NARRATIVE_METADATA_CONCURRENCY,
      llmMinFastScore: env.NARRATIVE_LLM_MIN_FAST_SCORE,
      llmWeight: env.NARRATIVE_LLM_WEIGHT,
    },
    llm,
  );

  await sub.subscribe(NEW_POOLS_CHANNEL);
  sub.on("message", (_channel, payload) => {
    let event: PoolEvent;
    try {
      event = JSON.parse(payload) as PoolEvent;
    } catch {
      return;
    }
    if (!event?.tokenMint) return;
    void service.handle(event).catch((err) => logger.warn({ err: (err as Error).message }, "launch scoring failed"));
  });
  logger.info({ channel: NEW_POOLS_CHANNEL, ttlSec: env.NARRATIVE_TTL_SEC, metasFile: metasFile || null }, "narrative scorer listening");

  const statsTimer = setInterval(() => {
    logger.info(
      {
        ...service.stats,
        llmSkippedBusy: llm?.skippedBusy,
        llmFailures: llm?.failures,
        metas: metas.stats(),
        hotThemes1h: service.topSaturation(),
      },
      "stats",
    );
  }, 60_000);

  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, "shutdown");
      clearInterval(statsTimer);
      if (selfTimer) clearInterval(selfTimer);
      metas.stop();
      await sub.quit().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await self?.close().catch(() => undefined);
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, "narrative scorer crashed");
  process.exit(1);
});
