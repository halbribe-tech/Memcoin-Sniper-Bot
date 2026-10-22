-- Hit rate + avg PnL per narrative score bucket (same as scripts/report.ts).
-- psql "$DATABASE_URL" -f apps/narrative/scripts/report.sql
WITH nr AS (
  SELECT DISTINCT ON (f."poolId") f."poolId", f.metadata
    FROM "FilterResult" f
   WHERE f."filterId" = 'narrative'
   ORDER BY f."poolId", f."evaluatedAt" DESC
), j AS (
  SELECT p."realizedPnlUsd" AS pnl,
         p."entrySizeUsd"   AS size,
         (nr.metadata->>'narrativeScore')::float AS score
    FROM "Position" p
    LEFT JOIN nr ON nr."poolId" = p."poolId"
   WHERE p.status = 'closed'
)
SELECT CASE
         WHEN score IS NULL THEN 'no score'
         WHEN score >= 80 THEN '80-100 (S)'
         WHEN score >= 65 THEN '65-79 (A)'
         WHEN score >= 50 THEN '50-64 (B)'
         WHEN score >= 35 THEN '35-49 (C)'
         WHEN score >= 20 THEN '20-34 (D)'
         ELSE '0-19 (D)'
       END AS bucket,
       count(*)                                                        AS trades,
       round(100.0 * avg(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::numeric, 1) AS hit_rate_pct,
       round(avg(pnl)::numeric, 2)                                     AS avg_pnl_usd,
       round(avg(CASE WHEN size > 0 THEN pnl / size * 100 END)::numeric, 1) AS avg_pnl_pct,
       round(sum(pnl)::numeric, 2)                                     AS total_pnl_usd
  FROM j
 GROUP BY 1
 ORDER BY 1 DESC;
