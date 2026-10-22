import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PUMP_CURVE_FEE, curveBuyQuote } from "./curve-quote.js";

// a fresh standard curve: 30 virtual SOL, 1.073B virtual tokens
const START = { virtualSolLamports: 30_000_000_000n, virtualTokenRaw: 1_073_000_000_000_000n };
const SOL_USD = 100;

describe("curve buy quote", () => {
  test("a tiny buy pays the curve's spot price plus the fee", () => {
    const q = curveBuyQuote(START, 0.01, SOL_USD)!;
    const spot = (30 / 1_073_000_000) * SOL_USD;
    assert.ok(Math.abs(q.priceUsd / spot - 1 / (1 - PUMP_CURVE_FEE)) < 1e-4);
    assert.equal(q.liquidityUsd, 30 * SOL_USD);
  });

  test("$100 into 30 SOL pays ~3.3% over spot for impact, plus the fee", () => {
    const q = curveBuyQuote(START, 100, SOL_USD)!;
    const spot = (30 / 1_073_000_000) * SOL_USD;
    const premium = (q.priceUsd / spot - 1) * 100;
    assert.ok(premium > 4 && premium < 5, `premium ${premium.toFixed(2)}%`);
  });

  test("no quote without reserves or a SOL price", () => {
    assert.equal(curveBuyQuote({ virtualSolLamports: 0n, virtualTokenRaw: 1n }, 100, SOL_USD), null);
    assert.equal(curveBuyQuote(START, 100, 0), null);
  });
});
