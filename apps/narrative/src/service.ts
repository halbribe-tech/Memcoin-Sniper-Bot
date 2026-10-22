import PQueue from "p-queue";
import { narrativeTier, type NarrativeScore, type PoolEvent } from "@sniperbot/shared";
import type { MetaStore } from "./metas.js";
import { scoreLaunch, type LaunchText } from "./scorer.js";
import { SaturationTracker } from "./saturation.js";
import { fetchLaunchMetadata, type LaunchMetadata } from "./metadata.js";
import { blend, type LlmJudge } from "./llm.js";
import { childLogger } from "./logger.js";

const log = childLogger("service");

export interface ServiceConfig {
  halfLifeH: number;
  saturationFree: number;
  copycatMaxAgeMs: number;
  metadataTimeoutMs: number;
  metadataConcurrency: number;
  llmMinFastScore: number;
  llmWeight: number;
}

export type Writer = (score: NarrativeScore) => Promise<void>;
export type MetadataFetcher = (uri: string | undefined, timeoutMs: number) => Promise<LaunchMetadata | null>;

/**
 * Per launch, three writes to narrative:<mint>, each one better than the last:
 * 1. "fast"     name + ticker only, within milliseconds of the pool event
 * 2. "metadata" + description and socials from the metadata JSON (≤ timeout)
 * 3. "llm"      blended with an LLM judgment, only when stage 2 scored high enough
 * The engine judges at breakout (typically 8-20s after creation), so whatever
 * stage is in Redis by then is what it records.
 */
export class NarrativeService {
  private readonly saturation = new SaturationTracker();
  private readonly metaQueue: PQueue;
  private readonly seen = new Map<string, number>();
  readonly stats = { launches: 0, fast: 0, metadata: 0, metadataMissing: 0, llm: 0, themed: 0, writeErrors: 0 };

  constructor(
    private readonly metas: MetaStore,
    private readonly write: Writer,
    private readonly cfg: ServiceConfig,
    private readonly llm: LlmJudge | null,
    private readonly fetchMetadata: MetadataFetcher = fetchLaunchMetadata,
  ) {
    this.metaQueue = new PQueue({ concurrency: cfg.metadataConcurrency });
  }

  topSaturation() {
    return this.saturation.top();
  }

  private score(mint: string, text: LaunchText, now = Date.now()): NarrativeScore {
    return scoreLaunch(mint, text, this.metas.snapshot(now), {
      now,
      halfLifeH: this.cfg.halfLifeH,
      saturationFree: this.cfg.saturationFree,
      copycatMaxAgeMs: this.cfg.copycatMaxAgeMs,
      saturation: (id) => this.saturation.count(id, now),
    });
  }

  private async put(s: NarrativeScore): Promise<void> {
    try {
      await this.write(s);
    } catch (err) {
      this.stats.writeErrors++;
      log.warn({ err: (err as Error).message, mint: s.mint.slice(0, 8) }, "narrative write failed");
    }
  }

  /** Resolves when every stage for this launch has finished. */
  async handle(event: PoolEvent): Promise<void> {
    const mint = event.tokenMint;
    const now = Date.now();
    if (this.seen.has(mint)) return;
    this.seen.set(mint, now);
    if (this.seen.size > 20_000) {
      for (const [k, at] of this.seen) if (now - at > 3600_000) this.seen.delete(k);
    }
    this.stats.launches++;

    const name = event.token?.name;
    const symbol = event.token?.symbol;

    // 1 — fast
    const fast = this.score(mint, { name, symbol, metadata: null }, now);
    let recorded = fast.theme;
    if (recorded) {
      this.saturation.record(recorded, now);
      this.stats.themed++;
    }
    await this.put(fast);
    this.stats.fast++;

    // 2 — metadata
    const md = await this.metaQueue.add(() => this.fetchMetadata(event.token?.metadataUri, this.cfg.metadataTimeoutMs));
    if (!md) {
      this.stats.metadataMissing++;
      return this.maybeLlm(fast, { name, symbol, metadata: null });
    }
    const withMd = this.score(mint, { name, symbol, metadata: md });
    if (withMd.theme && withMd.theme !== recorded) {
      this.saturation.record(withMd.theme);
      if (!recorded) this.stats.themed++;
      recorded = withMd.theme;
    }
    await this.put(withMd);
    this.stats.metadata++;

    // 3 — LLM
    await this.maybeLlm(withMd, { name, symbol, metadata: md });
  }

  private async maybeLlm(prev: NarrativeScore, text: LaunchText): Promise<void> {
    if (!this.llm || prev.fastScore < this.cfg.llmMinFastScore) return;
    const themes = this.metas.snapshot().themes.sort((a, b) => b.strength - a.strength);
    const j = await this.llm.judge(text, themes);
    if (!j) return;
    const score = blend(prev.fastScore, j.score, this.cfg.llmWeight);
    await this.put({
      ...prev,
      score,
      tier: narrativeTier(score),
      stage: "llm",
      llm: j,
      reason: `${prev.reason} · LLM ${j.score}${j.reason ? `: ${j.reason}` : ""}`,
      computedAt: Date.now(),
    });
    this.stats.llm++;
  }
}
