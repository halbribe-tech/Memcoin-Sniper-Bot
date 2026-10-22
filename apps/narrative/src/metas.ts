import { readFile, stat } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { z } from "zod";
import { compact, normalize } from "./text.js";
import { childLogger } from "./logger.js";

const log = childLogger("metas");

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "not an ISO date" });

/** One theme in metas.json. Documented in apps/narrative/README.md. */
export const ThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  aliases: z.array(z.string().min(1)).default([]),
  strength: z.number().min(0).max(100),
  firstSeen: isoDate,
  lastSeen: isoDate.optional(),
  expiresAt: isoDate.nullable().optional(),
  exampleTickers: z.array(z.string().min(1)).default([]),
  xLinks: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const MetasFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoDate,
  source: z.string().optional(),
  example: z.boolean().optional(),
  themes: z.array(ThemeSchema),
  winnerTickers: z
    .array(
      z.object({
        ticker: z.string().min(1),
        mint: z.string().optional(),
        seenAt: isoDate,
        note: z.string().optional(),
      }),
    )
    .default([]),
});

export type MetasFile = z.infer<typeof MetasFileSchema>;
export type MetaSource = "file" | "url" | "self";

export interface Term {
  raw: string;
  /** normalized words, space separated */
  norm: string;
  /** normalized, no spaces */
  compact: string;
}

export interface Theme {
  id: string;
  name: string;
  terms: Term[];
  strength: number;
  firstSeenMs: number;
  /** last time the theme was confirmed hot; firstSeen when unknown */
  lastSeenMs: number;
  expiresAtMs: number | null;
  /** compact, lowercase */
  exampleTickers: string[];
  source: MetaSource;
}

export interface WinnerTicker {
  /** compact, lowercase */
  ticker: string;
  display: string;
  seenAtMs: number;
  source: MetaSource;
}

export interface MetaSnapshot {
  themes: Theme[];
  winners: Map<string, WinnerTicker>;
}

function toTerm(raw: string): Term | null {
  const norm = normalize(raw);
  return norm ? { raw, norm, compact: norm.replace(/ /g, "") } : null;
}

export function compileMetas(file: MetasFile, source: MetaSource): { themes: Theme[]; winners: WinnerTicker[] } {
  const themes: Theme[] = file.themes.map((t) => ({
    id: t.id,
    name: t.name,
    terms: [...t.keywords, ...t.aliases].map(toTerm).filter((x): x is Term => x !== null),
    strength: t.strength,
    firstSeenMs: Date.parse(t.firstSeen),
    lastSeenMs: Date.parse(t.lastSeen ?? file.generatedAt),
    expiresAtMs: t.expiresAt ? Date.parse(t.expiresAt) : null,
    exampleTickers: t.exampleTickers.map((x) => compact(x)).filter(Boolean),
    source,
  }));
  const winners: WinnerTicker[] = file.winnerTickers
    .map((w) => ({ ticker: compact(w.ticker), display: w.ticker, seenAtMs: Date.parse(w.seenAt), source }))
    .filter((w) => w.ticker);
  return { themes, winners };
}

/**
 * The merged meta list: the local file, the remote URL and the self-sourced
 * winners. On an id clash file beats url beats self. A source that fails to
 * load or validate keeps its last good version.
 */
export class MetaStore {
  private readonly bySource = new Map<MetaSource, { themes: Theme[]; winners: WinnerTicker[]; loadedAt: number }>();
  private fileTimer: string | null = null;
  private urlTimer: NodeJS.Timeout | null = null;
  private etag: string | null = null;

  set(source: MetaSource, data: { themes: Theme[]; winners: WinnerTicker[] }): void {
    this.bySource.set(source, { ...data, loadedAt: Date.now() });
  }

  snapshot(now = Date.now(), winnerMaxAgeMs = 24 * 3600_000): MetaSnapshot {
    const themes = new Map<string, Theme>();
    const winners = new Map<string, WinnerTicker>();
    for (const source of ["self", "url", "file"] as const) {
      const s = this.bySource.get(source);
      if (!s) continue;
      for (const t of s.themes) {
        if (t.expiresAtMs !== null && t.expiresAtMs <= now) continue;
        themes.set(t.id, t);
      }
      for (const w of s.winners) {
        if (now - w.seenAtMs > winnerMaxAgeMs) continue;
        const prev = winners.get(w.ticker);
        if (!prev || prev.seenAtMs < w.seenAtMs) winners.set(w.ticker, w);
      }
    }
    return { themes: [...themes.values()], winners };
  }

  stats() {
    const out: Record<string, { themes: number; winners: number; ageSec: number }> = {};
    for (const [k, v] of this.bySource) {
      out[k] = { themes: v.themes.length, winners: v.winners.length, ageSec: Math.round((Date.now() - v.loadedAt) / 1000) };
    }
    return out;
  }

  /** Load the file now and again whenever it changes (polled stat, so an atomic replace is seen too). */
  watchFile(path: string): void {
    const load = async () => {
      try {
        await stat(path);
      } catch {
        log.warn({ path }, "metas file not found — waiting for it (self-sourced metas still work)");
        return;
      }
      try {
        const parsed = MetasFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
        const data = compileMetas(parsed, "file");
        this.set("file", data);
        log.info(
          { path, themes: data.themes.length, winners: data.winners.length, generatedAt: parsed.generatedAt, example: parsed.example ?? false },
          "metas file loaded",
        );
      } catch (err) {
        log.error({ path, err: (err as Error).message }, "metas file invalid — keeping the last good version");
      }
    };
    void load();
    watchFile(path, { interval: 2000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) void load();
    });
    this.fileTimer = path;
  }

  /** Poll a remote metas.json; ETag aware, optional bearer token. */
  pollUrl(url: string, everySec: number, token: string): void {
    const load = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        if (this.etag) headers["if-none-match"] = this.etag;
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = MetasFileSchema.parse(await res.json());
        const data = compileMetas(parsed, "url");
        this.set("url", data);
        this.etag = res.headers.get("etag");
        log.info({ themes: data.themes.length, winners: data.winners.length, generatedAt: parsed.generatedAt }, "metas url loaded");
      } catch (err) {
        log.warn({ err: (err as Error).message }, "metas url failed — keeping the last good version");
      } finally {
        clearTimeout(timer);
      }
    };
    void load();
    this.urlTimer = setInterval(() => void load(), everySec * 1000);
    this.urlTimer.unref();
  }

  stop(): void {
    if (this.fileTimer) unwatchFile(this.fileTimer);
    if (this.urlTimer) clearInterval(this.urlTimer);
  }
}
