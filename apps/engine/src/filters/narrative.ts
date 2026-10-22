import { narrativeKey, type NarrativeScore } from "@sniperbot/shared";
import type { Filter } from "./types.js";
import { makeResult } from "./types.js";
import { getRedis } from "../state/redis.js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("filter:narrative");

// One Redis GET; a slow or dead Redis must never hold a verdict up.
const READ_TIMEOUT_MS = 150;

type Reader = (mint: string) => Promise<string | null>;

let reader: Reader = (mint) => getRedis().get(narrativeKey(mint));

/** Tests swap the Redis read for a stub. */
export function setNarrativeReader(r: Reader): void {
  reader = r;
}

async function readScore(mint: string): Promise<NarrativeScore | null | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), READ_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([reader(mint), timeout]);
    if (raw === "timeout") return "timeout";
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NarrativeScore;
    return typeof parsed.score === "number" ? parsed : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The narrative score apps/narrative computed for this launch (theme match to
 * the current metas, freshness, copycat, saturation, X link, optional LLM).
 *
 * NARRATIVE_FILTER_MODE=shadow (default): weight 0 and never "fail", so no
 * verdict changes. At or over the min score it reports "pass", under it
 * "skip" with metadata.wouldReject — the Analytics page then shows the
 * filter's lift and scripts/report.ts the hit rate per score bucket.
 */
export const narrativeFilter: Filter = {
  id: "narrative",
  get weight() {
    return env.NARRATIVE_FILTER_MODE === "gate" ? env.NARRATIVE_FILTER_WEIGHT : 0;
  },
  usesRpc: false,
  enabled: true,
  async evaluate(pool, ctx) {
    const start = Date.now();
    const shadow = env.NARRATIVE_FILTER_MODE !== "gate";
    const minScore = ctx.cfg.narrativeMinScore;

    let n: NarrativeScore | null | "timeout";
    try {
      n = await readScore(pool.tokenMint);
    } catch (err) {
      log.debug({ err: (err as Error).message, mint: pool.tokenMint.slice(0, 8) }, "narrative read failed");
      return makeResult("narrative", "skip", "narrative score unreadable", {
        metadata: { shadow, unavailable: "error" },
        durationMs: Date.now() - start,
      });
    }
    if (n === "timeout" || n === null) {
      return makeResult(
        "narrative",
        "skip",
        n === "timeout" ? "narrative read timed out" : "no narrative score yet",
        { metadata: { shadow, unavailable: n === "timeout" ? "timeout" : "missing" }, durationMs: Date.now() - start },
      );
    }

    const score = Math.max(0, Math.min(100, Math.round(n.score)));
    const ok = score >= minScore;
    const label = `narrative ${score}/100 tier ${n.tier}${n.themeName ? ` [${n.themeName}]` : ""}`;
    const metadata = {
      shadow,
      wouldReject: !ok,
      narrativeScore: score,
      fastScore: n.fastScore,
      tier: n.tier,
      theme: n.theme,
      themeName: n.themeName,
      stage: n.stage,
      copycatOf: n.signals?.copycatOf ?? null,
      saturation1h: n.signals?.saturation1h ?? 0,
      hasXLink: n.signals?.hasXLink ?? false,
      llmScore: n.llm?.score ?? null,
      reason: n.reason,
      ageMs: Date.now() - n.computedAt,
    };
    const durationMs = Date.now() - start;

    if (ok) return makeResult("narrative", "pass", label, { score, metadata, durationMs });
    if (shadow) {
      return makeResult("narrative", "skip", `shadow: ${label} < min ${minScore}`, { score, metadata, durationMs });
    }
    return makeResult("narrative", "fail", `${label} < min ${minScore}`, { score, metadata, durationMs });
  },
};
