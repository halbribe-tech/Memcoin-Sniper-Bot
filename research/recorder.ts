// Records every new pump.fun launch and its trades from the Helius log stream
// to JSONL, for offline strategy simulation on live data.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePumpCreateEvent, decodeTradeEvents } from "../apps/engine/src/feeds/parsers/pumpfun-event.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(ROOT, "apps/engine/package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const OUT = process.argv[2]!;
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const key = env.HELIUS_API_KEY;
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
  wsEndpoint: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
  commitment: "processed",
});

const TRACK_MS = 40 * 60_000;
const tracked = new Map<string, number>(); // mint -> created at (ms)
let buf: string[] = [];
let creates = 0;
let trades = 0;

function write(o: object) {
  buf.push(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
setInterval(() => {
  if (buf.length) appendFileSync(OUT, buf.join("\n") + "\n");
  buf = [];
  const now = Date.now();
  for (const [m, t] of tracked) if (now - t > TRACK_MS) tracked.delete(m);
}, 2000);
setInterval(() => console.log(new Date().toISOString(), "creates", creates, "trades", trades, "tracked", tracked.size), 60_000);

conn.onLogs(
  new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  (logs: { err: unknown; logs: string[]; signature: string }, ctx: { slot: number }) => {
    if (logs.err) return;
    const t = Date.now();
    const c = decodePumpCreateEvent(logs.logs);
    if (c && !tracked.has(c.mint)) {
      tracked.set(c.mint, t);
      creates++;
      write({
        k: "c", t, s: ctx.slot, m: c.mint, dev: c.user, mh: c.isMayhemMode ? 1 : 0, q: c.quoteMint,
        vsr: c.virtualSolReserves, vtr: c.virtualTokenReserves,
      });
    }
    for (const tr of decodeTradeEvents(logs.logs)) {
      if (!tracked.has(tr.mint)) continue;
      trades++;
      write({
        k: "t", t, s: ctx.slot, m: tr.mint, u: tr.user, b: tr.isBuy ? 1 : 0,
        sol: tr.solAmount, tok: tr.tokenAmount, vsr: tr.virtualSolReserves, vtr: tr.virtualTokenReserves,
      });
    }
  },
  "processed",
);
console.log("recording to", OUT);
