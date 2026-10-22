import { decodePumpCreateEvent, decodeTradeEvents } from "./parsers/pumpfun-event.js";

// raw units: 1B tokens at 6 decimals
const TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n;
// a bundle lands with the create in its slot; the slot after catches its stragglers
const LAUNCH_SLOTS = 1;
const FORGET_AFTER_MS = 15 * 60_000;

interface Launch {
  slot: number;
  dev: string;
  seenAt: number;
  devBought: bigint;
  devHeld: bigint;
  // non-dev wallets that bought in the launch slots → tokens they still hold
  launchBuyers: Map<string, bigint>;
}

/** What a launch's first buyers did, as of now. */
export interface LaunchStats {
  launchBuyers: number;
  /** % of supply still held by the wallets that bought in the launch slots, dev excluded */
  launchBuyersHeldPct: number;
  devBoughtPct: number;
  /** % of their own buy the dev has sold */
  devSoldPct: number;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? (Number(part) / Number(whole)) * 100 : 0);

/**
 * Follows every new pump.fun coin's trades from the log stream the detector
 * already receives, so it knows who bought in the launch slot and what they
 * still hold at no RPC cost. The RPC-based bundle check asked for a coin's
 * newest 20 signatures, which 90s after launch are ordinary trades, and could
 * not parse version-1 transactions, so it almost always saw nobody.
 */
export class LaunchTracker {
  private readonly launches = new Map<string, Launch>();
  private lastSweep = 0;

  ingest(logs: readonly string[], slot: number, now = Date.now()): void {
    const created = decodePumpCreateEvent(logs);
    if (created && !this.launches.has(created.mint)) {
      this.launches.set(created.mint, {
        slot,
        dev: created.user,
        seenAt: now,
        devBought: 0n,
        devHeld: 0n,
        launchBuyers: new Map(),
      });
    }
    for (const t of decodeTradeEvents(logs)) {
      const l = this.launches.get(t.mint);
      if (!l) continue;
      const signed = t.isBuy ? t.tokenAmount : -t.tokenAmount;
      if (t.user === l.dev) {
        if (t.isBuy) l.devBought += t.tokenAmount;
        l.devHeld += signed;
      } else if (l.launchBuyers.has(t.user)) {
        l.launchBuyers.set(t.user, l.launchBuyers.get(t.user)! + signed);
      } else if (t.isBuy && slot <= l.slot + LAUNCH_SLOTS) {
        l.launchBuyers.set(t.user, t.tokenAmount);
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
    };
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [mint, l] of this.launches) if (now - l.seenAt > FORGET_AFTER_MS) this.launches.delete(mint);
  }
}

export const launchTracker = new LaunchTracker();
