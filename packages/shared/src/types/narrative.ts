/**
 * Narrative scores, written by apps/narrative and read by the engine's
 * `narrative` filter. One Redis key per mint, with a TTL.
 */
export const NARRATIVE_KEY_PREFIX = "narrative:";

/** Redis pub/sub channel the engine publishes every detected pool on (state/pool-stream.ts). */
export const NEW_POOLS_CHANNEL = "channel:new-pools";

export function narrativeKey(mint: string): string {
  return NARRATIVE_KEY_PREFIX + mint;
}

export type NarrativeTier = "S" | "A" | "B" | "C" | "D";

/** How far the service got with a launch: name/ticker only, + metadata JSON, + LLM. */
export type NarrativeStage = "fast" | "metadata" | "llm";

export interface NarrativeLlmJudgment {
  provider: string;
  model: string;
  score: number;
  theme: string | null;
  reason: string;
  confidence?: number;
  durationMs: number;
}

export interface NarrativeScore {
  mint: string;
  /** 0-100, after the LLM blend when there is one */
  score: number;
  /** score before the LLM blend */
  fastScore: number;
  tier: NarrativeTier;
  /** id of the best matching theme, null when nothing matched */
  theme: string | null;
  themeName: string | null;
  reason: string;
  stage: NarrativeStage;
  signals: {
    themeMatch: number;
    themeStrength: number;
    matchedOn: string | null;
    copycatOf: string | null;
    saturation1h: number;
    hasXLink: boolean;
    hasWebsite: boolean;
    hasTelegram: boolean;
  };
  llm?: NarrativeLlmJudgment;
  computedAt: number;
}

export function narrativeTier(score: number): NarrativeTier {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}
