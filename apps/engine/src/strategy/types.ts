import type { BankrollSnapshot, PoolEvent, Position } from "@sniperbot/shared";
import type { CurveState, LaunchStats, LaunchTrade } from "../feeds/launch-tracker.js";

/** Open a paper position. */
export interface BuyOrder {
  sizeUsd: number;
  /** shown on the dashboard and stored with the decision */
  reason: string;
}

/** Sell part or all of an open position. */
export interface SellOrder {
  /** share of the tokens still held, 0 < fraction ≤ 1; 1 closes the position */
  fraction: number;
  /** stored as the trade's exit reason, e.g. "take-profit" */
  reason: string;
}

/** What the engine knows, for a strategy to read. Nothing here trades. */
export interface StrategyContext {
  now(): number;
  /** a pump.fun launch's first buyers, dev and curve fill, or null when this run never saw it */
  launch(mint: string): LaunchStats | null;
  /** a pump.fun curve's reserves after its last trade */
  curve(mint: string): CurveState | null;
  solPriceUsd(): number | undefined;
  bankroll(): BankrollSnapshot;
  openPositions(): Position[];
}

/**
 * The trading logic, and the only place it lives. The engine detects pools,
 * follows pump.fun curves, prices open positions and executes paper buys and
 * sells; every decision to buy or sell comes from here.
 *
 * Each hook returns an order or null. A buy for a coin already held is ignored.
 */
export interface Strategy {
  /** A new pool passed the detector. */
  onPool(pool: PoolEvent, ctx: StrategyContext): BuyOrder | null | Promise<BuyOrder | null>;
  /** A trade on the curve of a pump.fun launch this run saw created (for entries that wait). */
  onTrade(trade: LaunchTrade, pool: PoolEvent, ctx: StrategyContext): BuyOrder | null;
  /** An open position has a new price: from its curve's trades, else from Jupiter every 3s. */
  onPrice(position: Position, ctx: StrategyContext): SellOrder | null;
}
