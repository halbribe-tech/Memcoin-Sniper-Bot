import { test } from "node:test";
import assert from "node:assert/strict";
import type { NarrativeScore, PoolEvent } from "@sniperbot/shared";
import { MetaStore, compileMetas } from "./metas.js";
import { NarrativeService } from "./service.js";

const metas = new MetaStore();
metas.set(
  "file",
  compileMetas(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      themes: [
        { id: "frog", name: "Frogs", keywords: ["frog"], aliases: [], strength: 80, firstSeen: new Date().toISOString(), exampleTickers: [], xLinks: [] },
      ],
      winnerTickers: [],
    },
    "file",
  ),
);

const cfg = {
  halfLifeH: 24,
  saturationFree: 8,
  copycatMaxAgeMs: 3600_000,
  metadataTimeoutMs: 100,
  metadataConcurrency: 2,
  llmMinFastScore: 45,
  llmWeight: 0.4,
};

const ev = (mint: string, name: string): PoolEvent =>
  ({ tokenMint: mint, token: { name, symbol: "X", metadataUri: "https://example.com/m.json" } }) as PoolEvent;

test("writes a fast score, then a metadata score; one launch once", async () => {
  const writes: NarrativeScore[] = [];
  const svc = new NarrativeService(metas, async (s) => void writes.push(s), cfg, null, async () => ({
    twitter: "https://x.com/frog",
  }));
  await svc.handle(ev("A", "Frog Lord"));
  await svc.handle(ev("A", "Frog Lord"));
  assert.deepEqual(writes.map((w) => w.stage), ["fast", "metadata"]);
  assert.equal(writes[0]!.theme, "frog");
  assert.ok(writes[1]!.score > writes[0]!.score);
  assert.equal(svc.stats.launches, 1);
});

test("metadata failure still leaves the fast score", async () => {
  const writes: NarrativeScore[] = [];
  const svc = new NarrativeService(metas, async (s) => void writes.push(s), cfg, null, async () => null);
  await svc.handle(ev("B", "Nothing Here"));
  assert.deepEqual(writes.map((w) => w.stage), ["fast"]);
  assert.equal(svc.stats.metadataMissing, 1);
});

test("a failing Redis write does not throw", async () => {
  const svc = new NarrativeService(metas, async () => {
    throw new Error("redis down");
  }, cfg, null, async () => null);
  await svc.handle(ev("C", "Frog"));
  assert.equal(svc.stats.writeErrors, 1);
});
