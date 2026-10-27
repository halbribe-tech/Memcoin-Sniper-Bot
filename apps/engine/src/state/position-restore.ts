import type { Position, TokenInfo, Trade } from "@sniperbot/shared";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getPrisma } from "./db.js";
import type { PositionRecord, PositionStore } from "./position-store.js";
import type { PnlTracker } from "../analytics/pnl-tracker.js";

const log = childLogger("position-restore");

export interface TradeRow {
  id: string;
  side: "buy" | "sell";
  status: "filled" | "failed" | "partial";
  priceUsd: number;
  amountTokens: number;
  amountUsd: number;
  feeSol: number;
  slippagePct: number;
  mevPenaltyPct: number | null;
  exitReason: string | null;
  signature: string | null;
  executedAt: Date;
}

export interface OpenPositionRow {
  id: string;
  tokenMint: string;
  mode: "paper" | "live";
  entryPriceUsd: number;
  entrySizeUsd: number;
  tokensHeld: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  peakGainPct: number;
  openedAt: Date;
  pool: { poolAddress: string; source: string; rawEvent?: unknown };
  trades: TradeRow[];
}

const toShared = (prismaEnum: string) => prismaEnum.replace(/_/g, "-");

/**
 * An open position as it stood when the last run stopped. The row itself is
 * only written at open and at close, so what happened in between is read
 * back from its trades: each partial sale lowers the tokens held and adds to
 * realized P&L.
 */
export function rebuildPosition(row: OpenPositionRow): { position: Position; trades: Trade[] } {
  const trades: Trade[] = row.trades
    .slice()
    .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime())
    .map((t) => ({
      id: t.id,
      positionId: row.id,
      side: t.side,
      status: t.status,
      priceUsd: t.priceUsd,
      amountTokens: t.amountTokens,
      amountUsd: t.amountUsd,
      feeSol: t.feeSol,
      slippagePct: t.slippagePct,
      mevPenaltyPct: t.mevPenaltyPct ?? undefined,
      exitReason: t.exitReason ?? undefined,
      signature: t.signature ?? undefined,
      executedAt: t.executedAt.getTime(),
    }));

  const initialTokens = row.tokensHeld;
  const sells = trades.filter((t) => t.side === "sell" && t.status === "filled");
  let sold = 0;
  let realizedPnlUsd = 0;
  for (const t of sells) {
    sold += t.amountTokens;
    realizedPnlUsd += t.amountUsd - (t.amountTokens / initialTokens) * row.entrySizeUsd;
  }

  const remainingTokens = Math.max(0, initialTokens - sold);
  // the latest price anyone saw: the last sale, else the entry
  const currentPriceUsd = sells[sells.length - 1]?.priceUsd ?? row.currentPriceUsd;
  const peakPriceUsd = Math.max(row.peakPriceUsd, currentPriceUsd);
  const peakGainPct = ((peakPriceUsd - row.entryPriceUsd) / row.entryPriceUsd) * 100;
  const unrealizedPnlPct = ((currentPriceUsd - row.entryPriceUsd) / row.entryPriceUsd) * 100;
  const token = (row.pool.rawEvent as { token?: TokenInfo } | null | undefined)?.token;

  return {
    trades,
    position: {
      id: row.id,
      poolAddress: row.pool.poolAddress,
      tokenMint: row.tokenMint,
      tokenSymbol: token?.symbol,
      tokenName: token?.name,
      tokenMetadataUri: token?.metadataUri,
      source: toShared(row.pool.source),
      mode: row.mode,
      entryPriceUsd: row.entryPriceUsd,
      entrySizeUsd: row.entrySizeUsd,
      initialTokens,
      remainingTokens,
      currentPriceUsd,
      unrealizedPnlUsd: (currentPriceUsd - row.entryPriceUsd) * remainingTokens,
      unrealizedPnlPct,
      realizedPnlUsd,
      peakPriceUsd,
      peakGainPct,
      openedAt: row.openedAt.getTime(),
      status: sells.length > 0 ? "partial" : "open",
    },
  };
}

/**
 * Put back what the last run left: its open positions, which the strategy
 * then carries on managing, and the realized totals of everything it closed,
 * so a restart neither strands a position nor resets the bankroll.
 */
export async function restorePositions(store: PositionStore, pnl: PnlTracker): Promise<void> {
  const prisma = getPrisma();
  const [closed, open] = await Promise.all([
    prisma.position.findMany({
      where: { mode: env.MODE, status: "closed" },
      select: { realizedPnlUsd: true, entrySizeUsd: true },
    }),
    prisma.position.findMany({
      where: { mode: env.MODE, status: { in: ["open", "partial"] } },
      include: { pool: true, trades: true },
    }),
  ]);

  const records: PositionRecord[] = open.map((row) => rebuildPosition(row as OpenPositionRow));

  store.restore(records);
  const openRealized = records.reduce((s, r) => s + r.position.realizedPnlUsd, 0);
  store.seedTotals({
    realizedPnlUsd: closed.reduce((s, p) => s + p.realizedPnlUsd, 0) + openRealized,
    wins: closed.filter((p) => p.realizedPnlUsd > 0).length,
    losses: closed.filter((p) => p.realizedPnlUsd <= 0).length,
  });
  pnl.seed(
    closed,
    [...closed, ...open].reduce((s, p) => s + p.entrySizeUsd, 0),
  );
  if (records.length > 0 || closed.length > 0) {
    log.info({ openRestored: records.length, closedBefore: closed.length }, "positions restored from the last run");
  }
}
