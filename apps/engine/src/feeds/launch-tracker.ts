import { EventEmitter } from "node:events";
import { decodePumpCreateEvent, decodeTradeEvents, isSolPaired } from "./parsers/pumpfun-event.js";

// raw units: 1B tokens at 6 decimals
const TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n;
// a bundle lands with the create in its slot; the slot after catches its stragglers
const LAUNCH_SLOTS = 1;
const FORGET_AFTER_MS = 15 * 60_000;
// a breakout this late is not a launch any more
const BREAKOUT_WINDOW_MS = FORGET_AFTER_MS;

interface Launch {
  slot: number;
  dev: string;
  seenAt: number;
  startPriceSol: number;
  // Mayhem and non-SOL coins are dropped by the detector, so they never break out
  tradable: boolean;
  buyLamports: bigint;
  devBought: bigint;
  devHeld: bigint;
  // non-dev wallets that bought in the launch slots → tokens they still hold
  launchBuyers: Map<string, bigint>;
  brokeOut: boolean;
}

/** What a launch's first buyers did, as of now. */
export interface LaunchStats {
  launchBuyers: number;
  /** % of supply still held by the wallets that bought in the launch slots, dev excluded */
  launchBuyersHeldPct: number;
  devBoughtPct: number;
  /** % of their own buy the dev has sold */
  devSoldPct: number;
  /** SOL spent on buys since the create, dev included */
  buySol: number;
}

/** When a launch counts as breaking out; null leaves breakouts off. */
export interface BreakoutRule {
  /** the curve's price over its start, e.g. 2 = doubled */
  multiple: number;
  minAgeSec: number;
  minBuySol: number;
  /** the dev may have sold less than this % of their own buy */
  maxDevSoldPct: number;
}

interface TrackerEvents {
  breakout: (mint: string) => void;
}

export declare interface LaunchTracker {
  on<E extends keyof TrackerEvents>(event: E, listener: TrackerEvents[E]): this;
  emit<E extends keyof TrackerEvents>(event: E, ...args: Parameters<TrackerEvents[E]>): boolean;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? (Number(part) / Number(whole)) * 100 : 0);

/**
 * Follows every new pump.fun coin's trades from the log stream the detector
 * already receives, so it knows who bought in the launch slot and what they
 * still hold at no RPC cost. The RPC-based bundle check asked for a coin's
 * newest 20 signatures, which 90s after launch are ordinary trades, and could
 * not parse version-1 transactions, so it almost always saw nobody.
 *
 * With a breakout rule it also says when a launch first doubles (or whatever
 * the rule asks) on real buying, which is when the breakout entry mode buys.
 */
export class LaunchTracker extends EventEmitter {
  private readonly launches = new Map<string, Launch>();
  private lastSweep = 0;
  private breakoutRule: BreakoutRule | null = null;

  setBreakoutRule(rule: BreakoutRule | null): void {
    this.breakoutRule = rule;
  }

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
        brokeOut: false,
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
        const priceSol = Number(t.virtualSolReserves) / 1e9 / (Number(t.virtualTokenReserves) / 1e6);
        this.checkBreakout(t.mint, l, priceSol, slot, now);
      }
    }
    if (now - this.lastSweep > 60_000) this.sweep(now);
  }

  stats(mint: string): LaunchStats | null {
    const l = this.launches.get(mint);
    if (!l) return null;
    let held = 0n;
    for (const tokens of l.launchBuyers.values()) if (tokens > 0n) held += tokens;
    const devSold = l.devBought - (l.devHeld > 0n ? l.devHeld : 0n);
    return {
      launchBuyers: l.launchBuyers.size,
      launchBuyersHeldPct: pct(held, TOTAL_SUPPLY_RAW),
      devBoughtPct: pct(l.devBought, TOTAL_SUPPLY_RAW),
      devSoldPct: pct(devSold > 0n ? devSold : 0n, l.devBought),
      buySol: Number(l.buyLamports) / 1e9,
    };
  }

  private checkBreakout(mint: string, l: Launch, priceSol: number, slot: number, now: number): void {
    const rule = this.breakoutRule;
    if (!rule || l.brokeOut || !l.tradable) return;
    // the create's own slot is the dev's and the bundle's, not a buyable move
    if (slot <= l.slot) return;
    const age = now - l.seenAt;
    if (age < rule.minAgeSec * 1000 || age > BREAKOUT_WINDOW_MS) return;
    if (priceSol < rule.multiple * l.startPriceSol) return;
    const s = this.stats(mint)!;
    if (s.buySol < rule.minBuySol) return;
    if (s.devBoughtPct > 0 && s.devSoldPct >= rule.maxDevSoldPct) return;
    l.brokeOut = true;
    this.emit("breakout", mint);
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [mint, l] of this.launches) if (now - l.seenAt > FORGET_AFTER_MS) this.launches.delete(mint);
  }
}

export const launchTracker = new LaunchTracker();
