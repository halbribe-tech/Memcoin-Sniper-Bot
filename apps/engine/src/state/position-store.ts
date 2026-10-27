import { EventEmitter } from "node:events";
import type {
  Position,
  Trade,
  ExitReason,
  PositionOpenedEvent,
  PositionUpdateEvent,
  PositionClosedEvent,
} from "@sniperbot/shared";
import { childLogger } from "../utils/logger.js";
import { getPrisma } from "./db.js";

const log = childLogger("position-store");

export interface PositionRecord {
  position: Position;
  trades: Trade[];
}

interface StoreEvents {
  "position-opened": (e: PositionOpenedEvent) => void;
  "position-update": (e: PositionUpdateEvent) => void;
  "position-closed": (e: PositionClosedEvent) => void;
}

export declare interface PositionStore {
  on<E extends keyof StoreEvents>(event: E, listener: StoreEvents[E]): this;
  emit<E extends keyof StoreEvents>(event: E, ...args: Parameters<StoreEvents[E]>): boolean;
}

export class PositionStore extends EventEmitter {
  private readonly open = new Map<string, PositionRecord>();
  private totalRealizedPnlUsd = 0;
  private totalEntryCostUsd = 0;
  private totalProceedsUsd = 0;
  private wins = 0;
  private losses = 0;
  private closedRecent: Position[] = [];

  /**
   * Take back positions a previous run left open, as they were: no persist,
   * no "opened" event (alerts and invested totals already counted them).
   */
  restore(records: PositionRecord[]): void {
    for (const rec of records) {
      if (this.open.has(rec.position.id)) continue;
      this.open.set(rec.position.id, rec);
    }
  }

  /** Forget every position and total: the stats reset, with the bot off. */
  reset(): void {
    this.open.clear();
    this.totalRealizedPnlUsd = 0;
    this.totalEntryCostUsd = 0;
    this.totalProceedsUsd = 0;
    this.wins = 0;
    this.losses = 0;
    this.closedRecent = [];
  }

  /** Totals from positions closed in earlier runs, so a restart keeps the bankroll. */
  seedTotals(t: { realizedPnlUsd: number; wins: number; losses: number }): void {
    this.totalRealizedPnlUsd += t.realizedPnlUsd;
    this.wins += t.wins;
    this.losses += t.losses;
  }

  add(position: Position, openTrade: Trade): void {
    if (this.open.has(position.id)) {
      log.warn({ id: position.id }, "duplicate position id; skipping");
      return;
    }
    this.open.set(position.id, { position, trades: [openTrade] });
    this.totalEntryCostUsd += position.entrySizeUsd;
    this.emit("position-opened", { type: "position-opened", position });
    void this.persistOpen(position, openTrade).catch((err) =>
      log.warn({ err, id: position.id }, "open persist failed"),
    );
    log.info(
      {
        id: position.id.slice(0, 8),
        mint: position.tokenMint.slice(0, 8),
        size: position.entrySizeUsd.toFixed(2),
        entryPrice: position.entryPriceUsd.toExponential(3),
      },
      "position opened",
    );
  }

  get(id: string): PositionRecord | undefined {
    return this.open.get(id);
  }

  list(): Position[] {
    return Array.from(this.open.values()).map((r) => r.position);
  }

  recentlyClosed(n = 25): Position[] {
    return this.closedRecent.slice(0, n);
  }

  count(): number {
    return this.open.size;
  }

  /** Apply a price: updates price, peak and unrealized PnL, and returns the position. */
  tickPrice(id: string, currentPriceUsd: number): Position | null {
    const rec = this.open.get(id);
    if (!rec) return null;
    const p = rec.position;
    p.currentPriceUsd = currentPriceUsd;
    if (currentPriceUsd > p.peakPriceUsd) {
      p.peakPriceUsd = currentPriceUsd;
      p.peakGainPct = ((currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    }
    p.unrealizedPnlUsd = (currentPriceUsd - p.entryPriceUsd) * p.remainingTokens;
    p.unrealizedPnlPct = ((currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    return p;
  }

  /** Emit a periodic snapshot for the dashboard. */
  emitUpdate(id: string): void {
    const rec = this.open.get(id);
    if (!rec) return;
    const p = rec.position;
    this.emit("position-update", {
      type: "position-update",
      positionId: p.id,
      currentPriceUsd: p.currentPriceUsd,
      unrealizedPnlUsd: p.unrealizedPnlUsd,
      unrealizedPnlPct: p.unrealizedPnlPct,
      peakPriceUsd: p.peakPriceUsd,
      peakGainPct: p.peakGainPct,
      remainingTokens: p.remainingTokens,
      realizedPnlUsd: p.realizedPnlUsd,
      status: p.status,
    });
  }

  /** Apply a sale of part of a position: fewer tokens held, its P&L realized. */
  applyPartialSell(id: string, tokensSold: number, proceedsUsd: number, sellTrade: Trade): Position | null {
    const rec = this.open.get(id);
    if (!rec) return null;
    const p = rec.position;
    rec.trades.push(sellTrade);
    const costBasis = (tokensSold / p.initialTokens) * p.entrySizeUsd;
    p.remainingTokens = Math.max(0, p.remainingTokens - tokensSold);
    p.realizedPnlUsd += proceedsUsd - costBasis;
    // a partial sale is money back in the bankroll now, not when the rest sells
    this.totalRealizedPnlUsd += proceedsUsd - costBasis;
    this.totalProceedsUsd += proceedsUsd;
    p.status = p.remainingTokens <= 1e-9 ? "closed" : "partial";
    void this.persistTrade(p.id, sellTrade).catch((err) =>
      log.warn({ err, id }, "trade persist failed"),
    );
    return p;
  }

  /**
   * Close a position fully — sells whatever remains and archives.
   */
  closeFully(
    id: string,
    proceedsUsd: number,
    sellTrade: Trade,
    reason: ExitReason,
  ): Position | null {
    const rec = this.open.get(id);
    if (!rec) return null;
    const p = rec.position;
    rec.trades.push(sellTrade);
    const tokensRemaining = p.remainingTokens;
    const costBasis = (tokensRemaining / p.initialTokens) * p.entrySizeUsd;
    const lastSalePnl = proceedsUsd - costBasis;
    p.realizedPnlUsd += lastSalePnl;
    p.remainingTokens = 0;
    p.status = "closed";
    p.closedAt = Date.now();
    p.closeReason = reason;
    p.unrealizedPnlUsd = 0;
    p.unrealizedPnlPct = 0;

    // partial sales were added as they happened; only this last sale is new
    this.totalRealizedPnlUsd += lastSalePnl;
    this.totalProceedsUsd += proceedsUsd;
    if (p.realizedPnlUsd > 0) this.wins++;
    else this.losses++;

    this.open.delete(id);
    this.closedRecent.unshift({ ...p });
    if (this.closedRecent.length > 100) this.closedRecent.length = 100;

    this.emit("position-closed", { type: "position-closed", position: p });

    void this.persistClose(p, sellTrade).catch((err) =>
      log.warn({ err, id }, "close persist failed"),
    );

    log.info(
      {
        id: id.slice(0, 8),
        mint: p.tokenMint.slice(0, 8),
        reason,
        realizedUsd: p.realizedPnlUsd.toFixed(2),
        peakPct: p.peakGainPct.toFixed(0),
        durationSec: Math.floor(((p.closedAt ?? Date.now()) - p.openedAt) / 1000),
      },
      "position closed",
    );
    return p;
  }

  getStats() {
    const total = this.wins + this.losses;
    return {
      open: this.open.size,
      totalClosed: total,
      wins: this.wins,
      losses: this.losses,
      winRatePct: total > 0 ? (this.wins / total) * 100 : 0,
      realizedPnlUsd: this.totalRealizedPnlUsd,
      openExposureUsd: Array.from(this.open.values()).reduce(
        (s, r) => s + r.position.remainingTokens * r.position.currentPriceUsd,
        0,
      ),
      unrealizedPnlUsd: Array.from(this.open.values()).reduce(
        (s, r) => s + r.position.unrealizedPnlUsd,
        0,
      ),
    };
  }

  // === Persistence ===

  private async persistOpen(p: Position, buyTrade: Trade): Promise<void> {
    const prisma = getPrisma();
    const pool = await prisma.pool.findUnique({ where: { poolAddress: p.poolAddress } });
    if (!pool) {
      log.warn({ poolAddress: p.poolAddress }, "pool not found at position open");
      return;
    }
    await prisma.position.create({
      data: {
        id: p.id,
        poolId: pool.id,
        tokenMint: p.tokenMint,
        mode: p.mode,
        entryPriceUsd: p.entryPriceUsd,
        entrySizeUsd: p.entrySizeUsd,
        tokensHeld: p.initialTokens,
        currentPriceUsd: p.currentPriceUsd,
        peakPriceUsd: p.peakPriceUsd,
        peakGainPct: p.peakGainPct,
        status: "open",
        openedAt: new Date(p.openedAt),
        trades: {
          create: [tradeToPrisma(buyTrade)],
        },
      },
    });
  }

  private async persistTrade(positionId: string, trade: Trade): Promise<void> {
    const prisma = getPrisma();
    await prisma.trade.create({ data: { ...tradeToPrisma(trade), positionId } });
  }

  private async persistClose(p: Position, sellTrade: Trade): Promise<void> {
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.trade.create({ data: { ...tradeToPrisma(sellTrade), positionId: p.id } }),
      prisma.position.update({
        where: { id: p.id },
        data: {
          status: "closed",
          tokensHeld: 0,
          currentPriceUsd: p.currentPriceUsd,
          peakPriceUsd: p.peakPriceUsd,
          peakGainPct: p.peakGainPct,
          unrealizedPnlUsd: 0,
          realizedPnlUsd: p.realizedPnlUsd,
          closedAt: p.closedAt ? new Date(p.closedAt) : new Date(),
          closeReason: p.closeReason ?? "manual",
        },
      }),
    ]);
  }
}

function tradeToPrisma(t: Trade) {
  return {
    id: t.id,
    side: t.side,
    status: t.status,
    priceUsd: t.priceUsd,
    amountTokens: t.amountTokens,
    amountUsd: t.amountUsd,
    feeSol: t.feeSol,
    slippagePct: t.slippagePct,
    mevPenaltyPct: t.mevPenaltyPct,
    exitReason: t.exitReason ?? null,
    signature: t.signature,
    executedAt: new Date(t.executedAt),
  };
}
