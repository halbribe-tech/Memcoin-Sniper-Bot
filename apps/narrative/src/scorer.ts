import { narrativeTier, type NarrativeScore, type NarrativeStage } from "@sniperbot/shared";
import type { MetaSnapshot, Theme } from "./metas.js";
import { compact, hasPhrase, normalize, similarity, tokens } from "./text.js";
import { isXLink, isXPost, type LaunchMetadata } from "./metadata.js";

export interface LaunchText {
  name?: string;
  symbol?: string;
  /** null = metadata not fetched (yet) */
  metadata: LaunchMetadata | null;
}

export interface ScoreOptions {
  now: number;
  halfLifeH: number;
  saturationFree: number;
  /** winners older than this do not count as a copy target */
  copycatMaxAgeMs: number;
  /** launches on a theme within the last hour, this one excluded */
  saturation: (themeId: string) => number;
}

export interface ThemeMatch {
  theme: Theme;
  /** 0..1 how well the launch hits the theme */
  match: number;
  matchedOn: string;
  field: "symbol" | "name" | "description";
  /** strength × freshness, 0..100 */
  effStrength: number;
  /** match × effStrength, 0..100 */
  themeScore: number;
}

// Score composition (sums to at most 100 before the clamp)
export const WEIGHTS = {
  base: 15,
  theme: 0.65, // × themeScore (0..100) → up to 65
  copycat: 10,
  xLink: 8,
  xPost: 4,
  website: 3,
  telegram: 2,
  saturationPerLaunch: 1.5,
  saturationMax: 25,
} as const;

/**
 * How current a theme is: halves every halfLifeH since it was last confirmed
 * hot (lastSeen), floor 0.5. The meta list's strength is the main signal;
 * this only fades themes nobody refreshed.
 */
export function freshness(lastSeenMs: number, now: number, halfLifeH: number): number {
  const ageH = Math.max(0, (now - lastSeenMs) / 3600_000);
  return Math.max(0.5, Math.pow(0.5, ageH / halfLifeH));
}

/** A theme that appeared in the last 12h gets a 15% bonus: early in a meta is where the moves are. */
export function novelty(firstSeenMs: number, now: number): number {
  return now - firstSeenMs <= 12 * 3600_000 ? 1.15 : 1;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface Prepared {
  nameNorm: string;
  nameTokens: string[];
  nameCompact: string;
  symCompact: string;
  descNorm: string;
}

function prepare(t: LaunchText): Prepared {
  return {
    nameNorm: normalize(t.name),
    nameTokens: tokens(t.name),
    nameCompact: compact(t.name),
    symCompact: compact(t.symbol),
    descNorm: normalize(t.metadata?.description),
  };
}

/** How well one theme matches; 0 when it does not. */
export function matchTheme(p: Prepared, theme: Theme): { match: number; matchedOn: string; field: ThemeMatch["field"] } {
  let best = { match: 0, matchedOn: "", field: "name" as ThemeMatch["field"] };
  const consider = (match: number, matchedOn: string, field: ThemeMatch["field"]) => {
    if (match > best.match) best = { match, matchedOn, field };
  };

  for (const t of p.symCompact ? theme.exampleTickers : []) {
    if (t === p.symCompact) consider(0.9, t, "symbol");
  }

  for (const term of theme.terms) {
    const c = term.compact;
    if (!c) continue;
    // ticker or name is the term
    if (p.symCompact === c) consider(1, term.raw, "symbol");
    if (hasPhrase(p.nameNorm, term.norm)) consider(1, term.raw, "name");
    // short terms ("ai", "go") only count as whole words / whole tickers
    if (c.length >= 4 || CJK.test(c)) {
      if (p.symCompact.includes(c)) consider(0.85, term.raw, "symbol");
      if (p.nameCompact.includes(c)) consider(0.85, term.raw, "name");
    }
    // near misses: typos and leetspeak-ish variants ("trumpp", "pepee")
    if (c.length >= 5) {
      for (const w of [...p.nameTokens, p.symCompact]) {
        if (w.length < 4) continue;
        const sim = similarity(w, c);
        if (sim >= 0.8 && sim < 1) consider(0.7 * sim, term.raw, w === p.symCompact ? "symbol" : "name");
      }
    }
    // the description says it
    if (p.descNorm && term.norm.length >= 3) {
      if (hasPhrase(p.descNorm, term.norm)) consider(0.55, term.raw, "description");
      else if (c.length >= 5 && p.descNorm.replace(/ /g, "").includes(c)) consider(0.45, term.raw, "description");
    }
  }
  return best;
}

export function bestThemeMatch(t: LaunchText, metas: MetaSnapshot, opts: Pick<ScoreOptions, "now" | "halfLifeH">): ThemeMatch | null {
  const p = prepare(t);
  let best: ThemeMatch | null = null;
  for (const theme of metas.themes) {
    const m = matchTheme(p, theme);
    if (m.match <= 0) continue;
    const effStrength = Math.min(
      100,
      theme.strength * freshness(theme.lastSeenMs, opts.now, opts.halfLifeH) * novelty(theme.firstSeenMs, opts.now),
    );
    const themeScore = m.match * effStrength;
    if (!best || themeScore > best.themeScore) best = { theme, ...m, effStrength, themeScore };
  }
  return best;
}

export function scoreLaunch(mint: string, t: LaunchText, metas: MetaSnapshot, opts: ScoreOptions): NarrativeScore {
  const best = bestThemeMatch(t, metas, opts);
  const sym = compact(t.symbol);
  const winner = sym ? metas.winners.get(sym) : undefined;
  const copycatOf = winner && opts.now - winner.seenAtMs <= opts.copycatMaxAgeMs ? winner.display : null;

  const md = t.metadata;
  const hasXLink = !!md && (isXLink(md.twitter) || isXLink(md.website));
  const hasXPost = !!md && (isXPost(md.twitter) || isXPost(md.website));
  const hasWebsite = !!md?.website && !isXLink(md.website);
  const hasTelegram = !!md?.telegram;

  const saturation1h = best ? opts.saturation(best.theme.id) : 0;
  const satPenalty = Math.min(
    WEIGHTS.saturationMax,
    Math.max(0, saturation1h - opts.saturationFree) * WEIGHTS.saturationPerLaunch,
  );

  const parts: string[] = [];
  let score = WEIGHTS.base;
  if (best) {
    score += WEIGHTS.theme * best.themeScore;
    parts.push(
      `theme ${best.theme.name} (${best.field} "${best.matchedOn}", match ${best.match.toFixed(2)} × strength ${best.effStrength.toFixed(0)})`,
    );
  } else {
    parts.push("no current meta");
  }
  if (copycatOf) {
    score += WEIGHTS.copycat;
    parts.push(`copy of winner ${copycatOf}`);
  }
  if (hasXLink) {
    score += WEIGHTS.xLink + (hasXPost ? WEIGHTS.xPost : 0);
    parts.push(hasXPost ? "X post link" : "X link");
  }
  if (hasWebsite) score += WEIGHTS.website;
  if (hasTelegram) score += WEIGHTS.telegram;
  if (satPenalty > 0) {
    score -= satPenalty;
    parts.push(`${saturation1h} same-theme launches/1h (-${satPenalty.toFixed(0)})`);
  }
  if (md === null) parts.push("metadata not read");

  const final = Math.round(Math.max(0, Math.min(100, score)));
  const stage: NarrativeStage = md === null ? "fast" : "metadata";
  return {
    mint,
    score: final,
    fastScore: final,
    tier: narrativeTier(final),
    theme: best?.theme.id ?? null,
    themeName: best?.theme.name ?? null,
    reason: parts.join(" · "),
    stage,
    signals: {
      themeMatch: best ? Number(best.match.toFixed(3)) : 0,
      themeStrength: best ? Math.round(best.effStrength) : 0,
      matchedOn: best?.matchedOn ?? null,
      copycatOf,
      saturation1h,
      hasXLink,
      hasWebsite,
      hasTelegram,
    },
    computedAt: opts.now,
  };
}
