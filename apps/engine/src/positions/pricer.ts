import type { Position } from "@sniperbot/shared";
import { childLogger } from "../utils/logger.js";
import type { MarketFeed } from "../execution/market-price.js";
import type { PaperBroker } from "../execution/broker.js";
import type { PositionStore } from "../state/position-store.js";
import type { Strategy, StrategyContext } from "../strategy/types.js";

// a curve price older than this falls back to the polled market price
const CURVE_FRESH_MS = 15_000;
const TICK_MS = 1000;
const log = childLogger("pricer");

/**
 * Keeps every open position priced and lets the strategy act on each new
 * price: on every trade of a pump.fun curve the position sits on, and once a
 * second from the polled market price. It sells only when the strategy says so.
 */
export class PositionPricer {
  private timer: NodeJS.Timeout | null = null;
  // mint → the curve's price from the last trade the log stream delivered
  private readonly curve = new Map<string, { priceUsd: number; liquidityUsd: number; at: number }>();

  constructor(
    private readonly store: PositionStore,
    private readonly market: MarketFeed,
    private readonly broker: PaperBroker,
    private readonly strategy: Strategy,
    private readonly ctx: StrategyContext,
  ) {}

  /** A trade on a pump.fun curve: positions on it are priced and judged at once. */
  onCurveTrade(mint: string, priceUsd: number, liquidityUsd: number): void {
    this.curve.set(mint, { priceUsd, liquidityUsd, at: Date.now() });
    for (const p of this.store.list()) {
      // the 1s tick tells the dashboard; a busy curve trades many times a second
      if (p.tokenMint === mint) this.step(p, false);
    }
  }

  /** A curve sold out: its coin moves to PumpSwap and the polled market price takes over. */
  onCurveComplete(mint: string): void {
    this.curve.delete(mint);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    for (const p of this.store.list()) this.step(p, true);
    const open = new Set(this.store.list().map((p) => p.tokenMint));
    for (const mint of this.curve.keys()) if (!open.has(mint)) this.curve.delete(mint);
  }

  private priceOf(mint: string): { priceUsd: number; liquidityUsd: number } | null {
    const c = this.curve.get(mint);
    if (c && Date.now() - c.at < CURVE_FRESH_MS) return c;
    const q = this.market.get(mint);
    return q ? { priceUsd: q.priceUsd, liquidityUsd: q.liquidityUsd ?? 0 } : null;
  }

  private step(p: Position, notify: boolean): void {
    const m = this.priceOf(p.tokenMint);
    if (!m) return;
    const updated = this.store.tickPrice(p.id, m.priceUsd);
    if (!updated) return;
    let order;
    try {
      order = this.strategy.onPrice(updated, this.ctx);
    } catch (err) {
      log.error({ err, id: p.id.slice(0, 8) }, "strategy.onPrice threw — holding");
      order = null;
    }
    if (order) this.broker.sell(p.id, order.fraction, order.reason, m.priceUsd, m.liquidityUsd);
    if (notify && this.store.get(p.id)) this.store.emitUpdate(p.id);
  }
}
