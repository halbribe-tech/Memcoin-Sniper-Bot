import { EventEmitter } from "node:events";
import { decodeCompleteEvents, decodePumpCreateEvent, decodeTradeEvents, isSolPaired } from "./parsers/pumpfun-event.js";

// raw units: 1B tokens at 6 decimals
const TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n;
// a bundle lands with the create in its slot; the slot after catches its stragglers
const LAUNCH_SLOTS = 1;
// long enough to keep pricing a position through its exits
const FORGET_AFTER_MS = 45 * 60_000;
// a breakout this late is not a launch any more
const BREAKOUT_WINDOW_MS = 15 * 60_000;
// a curve starts with 1.073B virtual tokens and sells 793.1M of them before it completes
const INITIAL_VIRTUAL_TOKENS_RAW = 1_073_000_000_000_000n;
const CURVE_SALE_RAW = 793_100_000_000_000n;
// the recorded launches that reached a fill level did so within 25 minutes
const FILL_WINDOW_MS = 25 * 60_000;
const FILL_MIN_AGE_MS = 5000;
// copy signals only count while the launch is young enough to have recorded data behind the rule
const COPY_WINDOW_MS = 30 * 60_000;

/** How much of the curve's sellable supply has been bought, 0-100. */
export function curveFillPct(virtualTokenRaw: bigint): number {
  return (Number(INITIAL_VIRTUAL_TOKENS_RAW - virtualTokenRaw) / Number(CURVE_SALE_RAW)) * 100;
}

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
  filled: boolean;
  // copied wallets that have bought since the create slot
  copyBuyers: Set<string>;
  copied: boolean;
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
  launchBuyers: number;
  /** % of supply still held by the wallets that bought in the launch slots, dev excluded */
  launchBuyersHeldPct: number;
  devBoughtPct: number;
  /** % of their own buy the dev has sold */
  devSoldPct: number;
  /** SOL spent on buys since the create, dev included */
  buySol: number;
}

/** Which wallets copy mode follows, and how many of them make a signal. */
export interface CopyRule {
  wallets: ReadonlySet<string>;
  /** the first count that is worth judging */
  minWallets: number;
  /** the count after which no more signals come; defaults to minWallets */
  strongWallets?: number;
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
  // a launch's curve reached the fill rule's level
  fill: (mint: string) => void;
  // a curve completed, tracked or not
  complete: (mint: string) => void;
  // another copied wallet bought the launch, from the rule's minimum up to its strong count
  copy: (mint: string, wallets: string[]) => void;
  // every trade on a tracked curve: its price and virtual SOL depth after the trade
  price: (mint: string, priceSol: number, virtualSol: number) => void;
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
  private fillPct: number | null = null;
  private copyRule: CopyRule | null = null;

  setBreakoutRule(rule: BreakoutRule | null): void {
    this.breakoutRule = rule;
  }

  /**
   * Say "copy" each time another of `wallets` buys a launch after its create
   * slot, from the `minWallets`th up to the `strongWallets`th; null leaves it off.
   */
  setCopyRule(rule: CopyRule | null): void {
    this.copyRule = rule;
  }

  /** Say "fill" when a launch's curve is first `pct`% sold; null leaves it off. */
  setFillRule(pct: number | null): void {
    this.fillPct = pct;
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
        filled: false,
        copyBuyers: new Set(),
        copied: false,
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
        this.checkBreakout(t.mint, l, priceSol, slot, now);
        this.checkFill(t.mint, l, slot, now);
        if (t.isBuy) this.checkCopy(t.mint, l, t.user, slot, now);
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

  /** The curve's reserves after the last trade seen on it, or null when this run never saw the launch. */
  curveState(mint: string): CurveState | null {
    return this.launches.get(mint)?.curve ?? null;
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

  private checkFill(mint: string, l: Launch, slot: number, now: number): void {
    const pct = this.fillPct;
    if (pct === null || l.filled || !l.tradable || slot <= l.slot) return;
    const age = now - l.seenAt;
    if (age < FILL_MIN_AGE_MS || age > FILL_WINDOW_MS) return;
    const fill = curveFillPct(l.curve.virtualTokenRaw);
    // a sold-out curve cannot be bought any more
    if (fill < pct || fill >= 100) return;
    l.filled = true;
    this.emit("fill", mint);
  }

  private checkCopy(mint: string, l: Launch, user: string, slot: number, now: number): void {
    const rule = this.copyRule;
    if (!rule || l.copied || !l.tradable || slot <= l.slot || !rule.wallets.has(user)) return;
    if (now - l.seenAt > COPY_WINDOW_MS || l.curve.complete) return;
    if (l.copyBuyers.has(user)) return;
    l.copyBuyers.add(user);
    if (l.copyBuyers.size < rule.minWallets) return;
    if (l.copyBuyers.size >= (rule.strongWallets ?? rule.minWallets)) l.copied = true;
    this.emit("copy", mint, [...l.copyBuyers]);
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [mint, l] of this.launches) if (now - l.seenAt > FORGET_AFTER_MS) this.launches.delete(mint);
  }
}

export const launchTracker = new LaunchTracker();
