import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaStore, MetasFileSchema, compileMetas } from "./metas.js";
import { freshness, scoreLaunch, type ScoreOptions } from "./scorer.js";
import { deriveSelfMetas } from "./self-source.js";
import { compact, normalize, similarity } from "./text.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = MetasFileSchema.parse(JSON.parse(readFileSync(resolve(here, "../metas.example.json"), "utf8")));
const NOW = Date.parse("2026-10-22T17:00:00Z");

function store() {
  const s = new MetaStore();
  s.set("file", compileMetas(example, "file"));
  return s;
}

const opts = (sat = 0): ScoreOptions => ({
  now: NOW,
  halfLifeH: 24,
  saturationFree: 8,
  copycatMaxAgeMs: 6 * 3600_000,
  saturation: () => sat,
});

const score = (name: string, symbol: string, description?: string, sat = 0) =>
  scoreLaunch("m", { name, symbol, metadata: description === undefined ? null : { description } }, store().snapshot(NOW), opts(sat));

test("text helpers", () => {
  assert.equal(normalize("DogWifHat"), "dog wif hat");
  assert.equal(compact("$PEPE-2"), "pepe2");
  assert.ok(similarity("trumpp", "trump") > 0.8);
});

test("theme hits score above launches with no meta", () => {
  const agent = score("Sentient Agent", "SAGENT");
  const random = score("Banana Republic", "BNNR");
  assert.equal(agent.theme, "ai-agents");
  assert.equal(random.theme, null);
  assert.ok(agent.score > random.score + 20, `${agent.score} vs ${random.score}`);
  assert.equal(random.tier, "D");
});

test("exact ticker of a theme term", () => {
  const s = score("kek", "PEPE");
  assert.equal(s.theme, "frog-pepe");
  assert.equal(s.signals.themeMatch, 1);
});

test("short keywords only match whole words", () => {
  // "agi" inside "magical" must not count
  assert.equal(score("Magical Unicorn", "MAGIC").theme, null);
  assert.equal(score("AGI Unicorn", "UNI").theme, "ai-agents");
});

test("fuzzy match catches near-miss spellings", () => {
  const s = score("Peppe the Froge", "PEPPE");
  assert.equal(s.theme, "frog-pepe");
});

test("description-only matches are weaker than name matches", () => {
  const byName = score("Frog King", "FKING");
  const byDesc = score("King Coin", "KCOIN", "a little frog that rules the pond");
  assert.equal(byDesc.theme, "frog-pepe");
  assert.ok(byName.score > byDesc.score);
});

test("non-latin keywords match", () => {
  assert.equal(score("中国龙", "LONG").theme, "cn-meme");
});

test("copycat of a recent winner ticker", () => {
  const s = score("Agent Two", "AGENT");
  assert.equal(s.signals.copycatOf, "AGENT");
});

test("saturation lowers the score", () => {
  const fresh = score("Frog King", "FKING", undefined, 0);
  const crowded = score("Frog King", "FKING", undefined, 30);
  assert.ok(crowded.score < fresh.score);
  assert.equal(crowded.signals.saturation1h, 30);
});

test("X link adds to the score once metadata is read", () => {
  const s = store().snapshot(NOW);
  const without = scoreLaunch("m", { name: "Banana", symbol: "BAN", metadata: {} }, s, opts());
  const withX = scoreLaunch("m", { name: "Banana", symbol: "BAN", metadata: { twitter: "https://x.com/banana/status/123" } }, s, opts());
  assert.ok(withX.signals.hasXLink);
  assert.equal(withX.score - without.score, 12);
  assert.equal(withX.stage, "metadata");
});

test("expired themes drop out", () => {
  const later = store().snapshot(Date.parse("2026-11-01T00:00:00Z"));
  assert.ok(!later.themes.some((t) => t.id === "ai-agents"));
  assert.ok(later.themes.some((t) => t.id === "frog-pepe"));
});

test("freshness decays but has a floor", () => {
  assert.equal(freshness(NOW, NOW, 24), 1);
  assert.ok(Math.abs(freshness(NOW - 12 * 3600_000, NOW, 24) - Math.SQRT1_2) < 1e-9);
  assert.equal(freshness(NOW - 30 * 24 * 3600_000, NOW, 24), 0.5);
});

test("self-sourced winners become themes and tickers", () => {
  const d = deriveSelfMetas([
    { name: "Moo Deng Hippo", symbol: "MOODENG", peakGainPct: 300, realizedPnlUsd: 20, at: new Date(NOW - 3600_000) },
    { name: "Baby Hippo", symbol: "BHIPPO", peakGainPct: 150, realizedPnlUsd: -2, at: new Date(NOW - 1800_000) },
  ]);
  const hippo = d.themes.find((t) => t.id === "self:hippo");
  assert.ok(hippo);
  assert.equal(hippo.strength, 50);
  assert.ok(d.winners.some((w) => w.ticker === "moodeng"));
  const s = new MetaStore();
  s.set("self", d);
  const r = scoreLaunch("m", { name: "Hippo Queen", symbol: "HQ", metadata: null }, s.snapshot(NOW), opts());
  assert.equal(r.theme, "self:hippo");
});

test("invalid metas are rejected by the schema", () => {
  assert.throws(() => MetasFileSchema.parse({ version: 1, generatedAt: "x", themes: [] }));
  assert.throws(() =>
    MetasFileSchema.parse({ version: 1, generatedAt: "2026-10-22T00:00:00Z", themes: [{ id: "a", name: "A", keywords: [], strength: 50, firstSeen: "2026-10-22T00:00:00Z" }] }),
  );
});

test("sample names", () => {
  const samples: Array<[string, string]> = [
    ["Sentient Agent", "SAGENT"],
    ["AI Agent Terminal", "TERM"],
    ["Pepe Classic", "PEPEC"],
    ["Dog Wif Hat 2", "WIF2"],
    ["Random Potato", "POTATO"],
    ["Binance Life", "BLIFE"],
  ];
  for (const [n, t] of samples) {
    const s = score(n, t);
    console.log(`${n.padEnd(20)} ${t.padEnd(8)} ${String(s.score).padStart(3)} ${s.tier} ${s.themeName ?? "-"}`);
  }
});
