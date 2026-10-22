/**
 * Hit rate per narrative score bucket: joins the narrative filter's results
 * (FilterResult, filterId = 'narrative') with closed positions.
 *
 *   pnpm --filter @sniperbot/narrative report [--hours 72] [--mode paper|live] [--min 50]
 *
 * Hit = a closed position with realizedPnlUsd > 0. Avg PnL is the cross-check.
 */
import pg from "pg";
import { env } from "../src/env.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hours = Number(arg("hours") ?? 0);
const mode = arg("mode");
const minScore = Number(arg("min") ?? process.env.NARRATIVE_MIN_SCORE ?? 50);

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

export const REPORT_SQL = `
WITH nr AS (
  SELECT DISTINCT ON (fr."poolId")
         fr."poolId",
         fr.status_score,
         fr.metadata
    FROM (
      SELECT f."poolId", f.score AS status_score, f.metadata, f."evaluatedAt"
        FROM "FilterResult" f
       WHERE f."filterId" = 'narrative'
    ) fr
   ORDER BY fr."poolId", fr."evaluatedAt" DESC
)
SELECT p.id,
       p."realizedPnlUsd"                          AS pnl,
       p."entrySizeUsd"                            AS size,
       p.mode,
       (nr.metadata->>'narrativeScore')::float     AS score,
       nr.metadata->>'tier'                        AS tier,
       nr.metadata->>'themeName'                   AS theme,
       nr.metadata->>'stage'                       AS stage,
       nr.metadata->>'unavailable'                 AS unavailable
  FROM "Position" p
  LEFT JOIN nr ON nr."poolId" = p."poolId"
 WHERE p.status = 'closed'
   AND ($1::int = 0 OR p."openedAt" > now() - make_interval(hours => $1::int))
   AND ($2::text IS NULL OR p.mode::text = $2::text)
`;

interface Row {
  pnl: number;
  size: number;
  score: number | null;
  tier: string | null;
  theme: string | null;
  stage: string | null;
}

const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "80-100 (S)", min: 80, max: 100 },
  { label: "65-79 (A)", min: 65, max: 79.999 },
  { label: "50-64 (B)", min: 50, max: 64.999 },
  { label: "35-49 (C)", min: 35, max: 49.999 },
  { label: "20-34 (D)", min: 20, max: 34.999 },
  { label: "0-19 (D)", min: 0, max: 19.999 },
];

interface Agg {
  label: string;
  n: number;
  wins: number;
  pnl: number;
  pnlPct: number;
}

function agg(label: string, rows: Row[]): Agg {
  const wins = rows.filter((r) => r.pnl > 0).length;
  const pnl = rows.reduce((s, r) => s + r.pnl, 0);
  const pnlPct = rows.reduce((s, r) => s + (r.size > 0 ? (r.pnl / r.size) * 100 : 0), 0);
  return { label, n: rows.length, wins, pnl, pnlPct };
}

function print(title: string, list: Agg[]) {
  console.log(`\n${title}`);
  console.log("  bucket              trades   hit rate   avg PnL $   avg PnL %   total PnL $");
  for (const a of list) {
    if (a.n === 0) {
      console.log(`  ${a.label.padEnd(18)} ${"0".padStart(7)}          -           -           -             -`);
      continue;
    }
    console.log(
      `  ${a.label.padEnd(18)} ${String(a.n).padStart(7)}   ${((a.wins / a.n) * 100).toFixed(1).padStart(6)}%   ${(a.pnl / a.n)
        .toFixed(2)
        .padStart(9)}   ${(a.pnlPct / a.n).toFixed(1).padStart(8)}%   ${a.pnl.toFixed(2).padStart(11)}`,
    );
  }
}

async function main() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<Row>(REPORT_SQL, [Math.round(hours), mode ?? null]);
    const rows = res.rows.map((r) => ({ ...r, pnl: Number(r.pnl), size: Number(r.size), score: r.score === null ? null : Number(r.score) }));
    const scored = rows.filter((r) => r.score !== null);
    console.log(
      `Narrative hit-rate report — ${rows.length} closed positions${hours ? ` in the last ${hours}h` : ""}${mode ? `, mode ${mode}` : ""}; ${scored.length} with a narrative score`,
    );
    print("All closed positions (baseline)", [agg("all", rows)]);
    print(
      "By narrative score",
      [
        ...BUCKETS.map((b) => agg(b.label, scored.filter((r) => r.score! >= b.min && r.score! <= b.max))),
        agg("no score", rows.filter((r) => r.score === null)),
      ],
    );
    print(`Shadow decision at min score ${minScore}`, [
      agg(`>= ${minScore} (pass)`, scored.filter((r) => r.score! >= minScore)),
      agg(`< ${minScore} (would reject)`, scored.filter((r) => r.score! < minScore)),
    ]);
    const byTheme = new Map<string, Row[]>();
    for (const r of scored) {
      const k = r.theme ?? "(no theme)";
      byTheme.set(k, [...(byTheme.get(k) ?? []), r]);
    }
    print(
      "By theme (3+ trades)",
      [...byTheme.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([k, v]) => agg(k.slice(0, 18), v)),
    );
    const byStage = new Map<string, Row[]>();
    for (const r of scored) byStage.set(r.stage ?? "?", [...(byStage.get(r.stage ?? "?") ?? []), r]);
    print("By scoring stage at verdict time", [...byStage.entries()].map(([k, v]) => agg(k, v)));
    if (rows.length < 30) console.log("\nNote: fewer than 30 trades — differences between buckets are mostly noise so far.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
