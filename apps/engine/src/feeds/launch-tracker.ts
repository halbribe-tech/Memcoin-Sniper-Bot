import { EventEmitter } from "node:events";
import { decodeCompleteEvents, decodePumpCreateEvent, decodeTradeEvents, isSolPaired } from "./parsers/pumpfun-event.js";
import type { PumpTradeEvent } from "./parsers/pumpfun-event.js";

// raw units: 1B tokens at 6 decimals
const TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n;
// a bundle lands with the create in its slot; the slot after catches its stragglers
const LAUNCH_SLOTS = 1;
// long enough to keep pricing a position bought in a launch's first half hour
const FORGET_AFTER_MS = 45 * 60_000;
// a curve starts with 1.073B virtual tokens and sells 793.1M of them before it completes
const INITIAL_VIRTUAL_TOKENS_RAW = 1_073_000_000_000_000n;
const CURVE_SALE_RAW = 793_100_000_000_000n;

/** How much of the curve's sellable supply has been bought, 0-100. */
export function curveFillPct(virtualTokenRaw: bigint): number {
  return (Number(INITIAL_VIRTUAL_TOKENS_RAW - virtualTokenRaw) / Number(CURVE_SALE_RAW)) * 100;
}

interface Launch {
  slot: number;
  dev: string;
  seenAt: number;
  startPriceSol: number;
  // Mayhem and non-SOL coins are dropped by the detector
  tradable: boolean;
  buyLamports: bigint;
  devBought: bigint;
  devHeld: bigint;
  // non-dev wallets that bought in the launch slots → tokens they still hold
  launchBuyers: Map<string, bigint>;
  // the curve's virtual reserves after the last trade the stream delivered
  curve: CurveState;
}

/** A pump.fun curve's virtual reserves, as of `at`. */
export interface CurveState {
  virtualSolLamports: bigint;
  virtualTokenRaw: bigint;
  at: number;
  /** the curve sold out and takes no more trades; the coin migrates to PumpSwap */
  complete: boolean;
}

/** What a launch's first buyers did, as of now. */
export interface LaunchStats {
  ageMs: number;
  startPriceSol: number;
  launchBuyers: number;
  /** % of supply still held by the wallets that bought in the launch slots, dev excluded */
  launchBuyersHeldPct: number;
  devBoughtPct: number;
  /** % of their own buy the dev has sold */
  devSoldPct: number;
  /** SOL spent on buys since the create, dev included */
  buySol: number;
  curveFillPct: number;
}

/** One trade on a tracked launch, with the slot it landed in. */
export interface LaunchTrade extends PumpTradeEvent {
  slot: number;
  at: number;
  priceSol: number;
}

interface TrackerEvents {
  // every trade on a tracked curve, for a strategy that wants the raw flow
  trade: (trade: LaunchTrade) => void;
  // every trade on a tracked curve: its price and virtual SOL depth after the trade
  price: (mint: string, priceSol: number, virtualSol: number) => void;
  // a curve completed, tracked or not
  complete: (mint: string) => void;
}

export declare interface LaunchTracker {
  on<E extends keyof TrackerEvents>(event: E, listener: TrackerEvents[E]): this;
  emit<E extends keyof TrackerEvents>(event: E, ...args: Parameters<TrackerEvents[E]>): boolean;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? (Number(part) / Number(whole)) * 100 : 0);

/**
 * Follows every new pump.fun coin's trades from the log stream the detector
 * already receives: who bought in the launch slot and what they still hold,
 * what the dev did, and the curve's reserves after each trade. No RPC cost.
 * It only observes; deciding what to do with it is the strategy's job.
 */
export class LaunchTracker extends EventEmitter {
  private readonly launches = new Map<string, Launch>();
  private lastSweep = 0;

  ingest(logs: readonly string[], slot: number, now = Date.now()): void {
    const created = decodePumpCreateEvent(logs);
    if (created && !this.launches.has(created.mint)) {
      this.launches.set(created.mint, {
        slot,
        dev: created.user,
        seenAt: now,
        startPriceSol: Number(created.virtualSolReserves) / 1e9 / (Number(created.virtualTokenReserves) / 1e6),
        tradable: !created.isMayhemMode && isSolPaired(created),
        buyLamports: 0n,
        devBought: 0n,
        devHeld: 0n,
        launchBuyers: new Map(),
        curve: {
          virtualSolLamports: created.virtualSolReserves,
          virtualTokenRaw: created.virtualTokenReserves,
          at: now,
          complete: false,
        },
      });
    }
    for (const t of decodeTradeEvents(logs)) {
      const l = this.launches.get(t.mint);
      if (!l) continue;
      const signed = t.isBuy ? t.tokenAmount : -t.tokenAmount;
      if (t.isBuy) l.buyLamports += t.solAmount;
      if (t.user === l.dev) {
        if (t.isBuy) l.devBought += t.tokenAmount;
        l.devHeld += signed;
      } else if (l.launchBuyers.has(t.user)) {
        l.launchBuyers.set(t.user, l.launchBuyers.get(t.user)! + signed);
      } else if (t.isBuy && slot <= l.slot + LAUNCH_SLOTS) {
        l.launchBuyers.set(t.user, t.tokenAmount);
      }
      if (t.virtualTokenReserves > 0n) {
        l.curve = { virtualSolLamports: t.virtualSolReserves, virtualTokenRaw: t.virtualTokenReserves, at: now, complete: false };
        const virtualSol = Number(t.virtualSolReserves) / 1e9;
        const priceSol = virtualSol / (Number(t.virtualTokenReserves) / 1e6);
        if (l.tradable) this.emit("trade", { ...t, slot, at: now, priceSol });
        this.emit("price", t.mint, priceSol, virtualSol);
      }
    }
    // after the trades: the buy that sells out the curve completes it in the same transaction
    for (const mint of decodeCompleteEvents(logs)) {
      const l = this.launches.get(mint);
      if (l) l.curve = { ...l.curve, complete: true };
      this.emit("complete", mint);
    }
    if (now - this.lastSweep > 60_000) this.sweep(now);
  }

  stats(mint: string, now = Date.now()): LaunchStats | null {
    const l = this.launches.get(mint);
    if (!l) return null;
    let held = 0n;
    for (const tokens of l.launchBuyers.values()) if (tokens > 0n) held += tokens;
    const devSold = l.devBought - (l.devHeld > 0n ? l.devHeld : 0n);
    return {
      ageMs: now - l.seenAt,
      startPriceSol: l.startPriceSol,
      launchBuyers: l.launchBuyers.size,
      launchBuyersHeldPct: pct(held, TOTAL_SUPPLY_RAW),
      devBoughtPct: pct(l.devBought, TOTAL_SUPPLY_RAW),
      devSoldPct: pct(devSold > 0n ? devSold : 0n, l.devBought),
      buySol: Number(l.buyLamports) / 1e9,
      curveFillPct: curveFillPct(l.curve.virtualTokenRaw),
    };
  }

  /** The curve's reserves after the last trade seen on it, or null when this run never saw the launch. */
  curveState(mint: string): CurveState | null {
    return this.launches.get(mint)?.curve ?? null;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [mint, l] of this.launches) if (now - l.seenAt > FORGET_AFTER_MS) this.launches.delete(mint);
  }
}

export const launchTracker = new LaunchTracker();
