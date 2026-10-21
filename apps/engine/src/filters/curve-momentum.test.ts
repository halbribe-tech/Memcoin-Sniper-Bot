import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PoolEvent } from "@sniperbot/shared";
import { PUMPFUN_START_PRICE_SOL, curveGainPct, curveMomentumFilter } from "./curve-momentum.js";
import type { FilterContext } from "./types.js";

const ctx = (isSynthetic = false) => ({ isSynthetic, cfg: { curveGainMinPct: 10 } }) as FilterContext;
const pool = (source: PoolEvent["source"]) => ({ source, tokenMint: "mint" }) as PoolEvent;

describe("curve-momentum", () => {
  test("the start price is 30 virtual SOL over 1.073B virtual tokens", () => {
    assert.ok(Math.abs(PUMPFUN_START_PRICE_SOL - 2.7959e-8) < 1e-12);
  });

  test("gain is measured against the curve start", () => {
    assert.ok(Math.abs(curveGainPct(PUMPFUN_START_PRICE_SOL)) < 1e-9);
    assert.ok(Math.abs(curveGainPct(PUMPFUN_START_PRICE_SOL * 1.5) - 50) < 1e-9);
    // seen live: a token with 34 buys and 21 sells, still at its launch price
    assert.ok(curveGainPct(0.00000002808) < 1);
  });

  test("anything but a live pump.fun curve is skipped without a lookup", async () => {
    assert.equal((await curveMomentumFilter.evaluate(pool("pumpswap"), ctx())).status, "skip");
    assert.equal((await curveMomentumFilter.evaluate(pool("raydium-amm"), ctx())).status, "skip");
    assert.equal((await curveMomentumFilter.evaluate(pool("pumpfun"), ctx(true))).status, "skip");
  });
});
