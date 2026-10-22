import { test } from "node:test";
import assert from "node:assert/strict";
import type { NarrativeScore, PoolEvent } from "@sniperbot/shared";
import { narrativeFilter, setNarrativeReader } from "./narrative.js";
import type { FilterContext } from "./types.js";

const pool = { tokenMint: "Mint111111111111111111111111111111111111111", poolAddress: "p" } as PoolEvent;
const ctx = { isSynthetic: false, cfg: { narrativeMinScore: 50 } } as unknown as FilterContext;

function score(s: number): NarrativeScore {
  return {
    mint: pool.tokenMint,
    score: s,
    fastScore: s,
    tier: s >= 50 ? "B" : "D",
    theme: "ai-agents",
    themeName: "AI Agents",
    reason: "test",
    stage: "fast",
    signals: { themeMatch: 1, themeStrength: 80, matchedOn: "agent", copycatOf: null, saturation1h: 1, hasXLink: false, hasWebsite: false, hasTelegram: false },
    computedAt: Date.now(),
  };
}

test("shadow mode: weight 0 and never fails", async () => {
  assert.equal(narrativeFilter.weight, 0);
  setNarrativeReader(async () => JSON.stringify(score(10)));
  const low = await narrativeFilter.evaluate(pool, ctx);
  assert.equal(low.status, "skip");
  assert.equal(low.score, 10);
  assert.equal(low.metadata?.wouldReject, true);
  setNarrativeReader(async () => JSON.stringify(score(72)));
  const high = await narrativeFilter.evaluate(pool, ctx);
  assert.equal(high.status, "pass");
  assert.equal(high.metadata?.narrativeScore, 72);
});

test("missing key or slow redis is a skip, not a wait", async () => {
  setNarrativeReader(async () => null);
  assert.equal((await narrativeFilter.evaluate(pool, ctx)).status, "skip");
  setNarrativeReader(() => new Promise((r) => setTimeout(() => r(null), 2000).unref()));
  const t0 = Date.now();
  const r = await narrativeFilter.evaluate(pool, ctx);
  assert.equal(r.status, "skip");
  assert.ok(Date.now() - t0 < 1000);
  setNarrativeReader(async () => {
    throw new Error("down");
  });
  assert.equal((await narrativeFilter.evaluate(pool, ctx)).status, "skip");
});
