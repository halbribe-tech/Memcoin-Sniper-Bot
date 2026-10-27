-- The filter pipeline, presets and rug list go with the strategy logic.
DROP TABLE "FilterResult";
DROP TABLE "FilterPreset";
DROP TABLE "RuggedDevWallet";

-- Decisions come from the strategy as "buy" or "skip"; no score.
ALTER TABLE "PoolDecision"
  ALTER COLUMN "decision" TYPE TEXT USING (CASE "decision" WHEN 'snipe' THEN 'buy' ELSE 'skip' END),
  DROP COLUMN "totalScore";

-- Exit rules lived on the position; exit reasons become the strategy's free text.
ALTER TABLE "Position"
  DROP COLUMN "filterScore",
  DROP COLUMN "tpLadder",
  DROP COLUMN "stopLossPct",
  DROP COLUMN "trailingStopArmed",
  ALTER COLUMN "closeReason" TYPE TEXT USING replace("closeReason"::text, '_', '-');

ALTER TABLE "Trade"
  ALTER COLUMN "exitReason" TYPE TEXT USING replace("exitReason"::text, '_', '-');

DROP TYPE "Decision";
DROP TYPE "ExitReason";
