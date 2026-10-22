/**
 * Score a name/ticker against the current metas file without Redis or the bot:
 *   pnpm --filter @sniperbot/narrative score -- "Dog Wif Hat" WIF ["description"]
 */
import { readFileSync, existsSync } from "node:fs";
import { env, repoPath } from "../src/env.js";
import { MetaStore, MetasFileSchema, compileMetas } from "../src/metas.js";
import { scoreLaunch } from "../src/scorer.js";

const [name, symbol, description] = process.argv.slice(2).filter((a) => a !== "--");
if (!name) {
  console.error('usage: score-once "<name>" <TICKER> ["description"]');
  process.exit(1);
}
const store = new MetaStore();
for (const p of [repoPath(env.NARRATIVE_METAS_FILE), repoPath("apps/narrative/metas.example.json")]) {
  if (!existsSync(p)) continue;
  store.set("file", compileMetas(MetasFileSchema.parse(JSON.parse(readFileSync(p, "utf8"))), "file"));
  console.log(`metas: ${p}`);
  break;
}
const now = Date.now();
const s = scoreLaunch("cli", { name, symbol, metadata: description ? { description } : null }, store.snapshot(now), {
  now,
  halfLifeH: env.NARRATIVE_FRESHNESS_HALFLIFE_H,
  saturationFree: env.NARRATIVE_SATURATION_FREE,
  copycatMaxAgeMs: env.NARRATIVE_SELF_LOOKBACK_H * 3600_000,
  saturation: () => 0,
});
console.log(JSON.stringify(s, null, 2));
