import type { Filter } from "./types.js";
import { makeResult } from "./types.js";
import { env } from "../config/env.js";
import { launchTracker } from "../feeds/launch-tracker.js";

/**
 * Rejects a launch whose first buyers are still sitting on enough supply to
 * dump it, or whose dev has already sold. Coins bought at +100-350% over
 * launch fell to the curve's start within 9-30s, sold in one move: the
 * supply was in a few hands from the first slot. Read from the trades the
 * log stream already delivers, so it costs no RPC credits.
 */
export const bundledLaunchFilter: Filter = {
  id: "bundled-launch",
  weight: 8,
  enabled: true,
  async evaluate(pool, ctx) {
    const start = Date.now();
    if (!ctx.cfg.bundledLaunchReject) {
      return makeResult("bundled-launch", "skip", "filter disabled", {
        durationMs: Date.now() - start,
      });
    }

    if (ctx.isSynthetic && ctx.syntheticMock) {
      const bundled = ctx.syntheticMock.bundledLaunch;
      return makeResult(
        "bundled-launch",
        bundled ? "fail" : "pass",
        bundled ? "first block dominated by sybil wallets" : "no bundled buy pattern",
        { durationMs: Date.now() - start },
      );
    }

    const s = pool.source === "pumpfun" ? launchTracker.stats(pool.tokenMint) : null;
    if (!s) {
      return makeResult("bundled-launch", "skip", "launch not seen by this engine run", {
        durationMs: Date.now() - start,
      });
    }

    const maxHeld = env.FILTER_BUNDLE_MAX_SUPPLY_PCT;
    const maxDevSold = env.FILTER_DEV_MAX_SOLD_PCT;
    const metadata = { ...s, maxHeldPct: maxHeld, maxDevSoldPct: maxDevSold };
    const held = `${s.launchBuyers} launch-slot buyer(s) hold ${s.launchBuyersHeldPct.toFixed(1)}%`;

    if (s.devBoughtPct > 0 && s.devSoldPct >= maxDevSold) {
      return makeResult(
        "bundled-launch",
        "fail",
        `dev already sold ${s.devSoldPct.toFixed(0)}% of their ${s.devBoughtPct.toFixed(1)}% buy`,
        { metadata, durationMs: Date.now() - start },
      );
    }
    if (s.launchBuyersHeldPct >= maxHeld) {
      return makeResult("bundled-launch", "fail", `${held} of supply ≥ ${maxHeld}% — ready to dump`, {
        metadata,
        durationMs: Date.now() - start,
      });
    }
    return makeResult("bundled-launch", "pass", `${held} of supply < ${maxHeld}%`, {
      metadata,
      durationMs: Date.now() - start,
    });
  },
};
