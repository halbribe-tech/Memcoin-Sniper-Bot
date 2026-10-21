import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FilterId, OrchestratorVerdict, PoolEvent } from "@sniperbot/shared";
import { FilterOrchestrator } from "./orchestrator.js";
import { makeResult, type Filter } from "./types.js";

const pool = { poolAddress: "p", tokenMint: "m", signature: "s", source: "pumpfun" } as PoolEvent;

function fake(id: FilterId, status: "pass" | "fail", usesRpc: boolean, calls: FilterId[]): Filter {
  return {
    id,
    weight: 1,
    usesRpc,
    enabled: true,
    async evaluate() {
      calls.push(id);
      return makeResult(id, status, status);
    },
  };
}

async function judge(filters: Filter[]): Promise<OrchestratorVerdict> {
  const orch = new FilterOrchestrator();
  (orch as unknown as { filters: Filter[] }).filters = filters;
  const verdict = new Promise<OrchestratorVerdict>((resolve) => orch.once("verdict-backtest", resolve));
  await orch.evaluate(pool, { persist: false });
  return verdict;
}

describe("filter stages", () => {
  test("a free filter's fail rejects without spending a single RPC filter", async () => {
    const calls: FilterId[] = [];
    const v = await judge([
      fake("volume-velocity", "fail", false, calls),
      fake("curve-momentum", "pass", false, calls),
      fake("top-holders", "pass", true, calls),
      fake("bundled-launch", "pass", true, calls),
    ]);
    assert.equal(v.decision, "reject");
    assert.deepEqual(calls.sort(), ["curve-momentum", "volume-velocity"]);
    assert.deepEqual(
      v.results.map((r) => [r.filterId, r.status]),
      [
        ["volume-velocity", "fail"],
        ["curve-momentum", "pass"],
        ["top-holders", "skip"],
        ["bundled-launch", "skip"],
      ],
    );
  });

  test("when every free filter passes, the RPC filters decide", async () => {
    const calls: FilterId[] = [];
    const v = await judge([
      fake("top-holders", "fail", true, calls),
      fake("curve-momentum", "pass", false, calls),
    ]);
    assert.equal(v.decision, "reject");
    assert.deepEqual(calls.sort(), ["curve-momentum", "top-holders"]);
    assert.match(v.decisionReason, /^top-holders/);
  });
});
