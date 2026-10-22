import pg from "pg";
import { childLogger } from "./logger.js";
import { STOPWORDS, compact, tokens } from "./text.js";
import type { Theme, WinnerTicker } from "./metas.js";

const log = childLogger("self-source");

export interface WinnerRow {
  name: string | null;
  symbol: string | null;
  peakGainPct: number;
  realizedPnlUsd: number;
  at: Date;
}

/**
 * Hot themes from the bot's own recent winners: every closed position that
 * peaked at minGainPct or more (or closed in profit) within the lookback.
 * Its ticker becomes a winner ticker (copycat signal). A telling word of the
 * name shared by at least MIN_WINNERS_PER_WORD winners becomes a
 * "self:<word>" theme whose strength grows with how many winners share it.
 */
export const MIN_WINNERS_PER_WORD = 2;

export function deriveSelfMetas(rows: WinnerRow[]): { themes: Theme[]; winners: WinnerTicker[] } {
  const words = new Map<string, { count: number; firstSeenMs: number; lastSeenMs: number; tickers: Set<string> }>();
  const winners: WinnerTicker[] = [];
  for (const r of rows) {
    const atMs = r.at.getTime();
    const sym = compact(r.symbol);
    if (sym) winners.push({ ticker: sym, display: r.symbol ?? sym, seenAtMs: atMs, source: "self" });
    const seen = new Set<string>();
    for (const w of tokens(r.name)) {
      if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
      seen.add(w);
      const e = words.get(w) ?? { count: 0, firstSeenMs: atMs, lastSeenMs: atMs, tickers: new Set<string>() };
      e.count++;
      e.firstSeenMs = Math.min(e.firstSeenMs, atMs);
      e.lastSeenMs = Math.max(e.lastSeenMs, atMs);
      if (sym) e.tickers.add(sym);
      words.set(w, e);
    }
  }
  const themes: Theme[] = [...words.entries()].filter(([, e]) => e.count >= MIN_WINNERS_PER_WORD).map(([w, e]) => ({
    id: `self:${w}`,
    name: `Self: ${w}`,
    terms: [{ raw: w, norm: w, compact: w }],
    strength: Math.min(75, 35 + 15 * (e.count - 1)),
    firstSeenMs: e.firstSeenMs,
    lastSeenMs: e.lastSeenMs,
    expiresAtMs: null,
    exampleTickers: [...e.tickers],
    source: "self" as const,
  }));
  return { themes, winners };
}

export class SelfSource {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    this.pool.on("error", (err) => log.warn({ err: err.message }, "pg pool error"));
  }

  async load(lookbackH: number, minGainPct: number): Promise<WinnerRow[]> {
    const res = await this.pool.query<{
      name: string | null;
      symbol: string | null;
      peakGainPct: number;
      realizedPnlUsd: number;
      at: Date;
    }>(
      `SELECT pl."rawEvent"->'token'->>'name'   AS name,
              pl."rawEvent"->'token'->>'symbol' AS symbol,
              p."peakGainPct"                    AS "peakGainPct",
              p."realizedPnlUsd"                 AS "realizedPnlUsd",
              COALESCE(p."closedAt", p."openedAt") AS at
         FROM "Position" p
         JOIN "Pool" pl ON pl.id = p."poolId"
        WHERE p.status = 'closed'
          AND COALESCE(p."closedAt", p."openedAt") > now() - make_interval(hours => $1::int)
          AND (p."peakGainPct" >= $2 OR p."realizedPnlUsd" > 0)
        ORDER BY at DESC
        LIMIT 300`,
      [Math.ceil(lookbackH), minGainPct],
    );
    return res.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
