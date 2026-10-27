// Records every new pump.fun launch and its trades from a Solana log stream
// to JSONL, for offline strategy simulation on live data. Curves that get far
// are followed to their migration, and the PumpSwap pool's trades after it.
//
// Line kinds:  c create · t curve trade · x curve complete · g migration (mint → pool)
//              a PumpSwap trade (pool reserves before the trade, as the event reports them)
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeCompleteEvents,
  decodePumpCreateEvent,
  decodeTradeEvents,
} from "../apps/engine/src/feeds/parsers/pumpfun-event.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(ROOT, "apps/engine/package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const OUT = process.argv[2]!;
// "public" (default) leaves the Helius stream quota to the bot; "helius" uses the key in .env
const SOURCE = process.argv[3] ?? "public";
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const [http, ws] =
  SOURCE === "helius"
    ? [`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`, `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`]
    : ["https://api.mainnet-beta.solana.com", "wss://api.mainnet-beta.solana.com"];
const conn = new Connection(http, { wsEndpoint: ws, commitment: "processed" });

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PROGRAM_DATA = "Program data: ";
// sha256("event:<name>")[0..8], from pump's and pump_amm's IDLs
const MIGRATION_EVENT = Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]);
const AMM_BUY_EVENT = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const AMM_SELL_EVENT = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);

const TRACK_MS = 40 * 60_000;
// a curve this far sold is followed to its migration even when its create was missed
const FOLLOW_FILL_PCT = 50;
const FOLLOW_MS = 3 * 60 * 60_000;
const INITIAL_VTR = 1_073_000_000_000_000n;
const CURVE_SALE = 793_100_000_000_000n;
const SILENCE_MS = 90_000;

const tracked = new Map<string, number>(); // mint -> tracked until (ms)
const pools = new Map<string, { mint: string; until: number }>(); // PumpSwap pool -> mint
let buf: string[] = [];
const n = { creates: 0, trades: 0, completes: 0, migrations: 0, swaps: 0 };
let lastMsg = Date.now();

function write(o: object) {
  buf.push(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const i128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigInt64LE(o + 8) << 64n);

/**
 * A PumpSwap pool prices on its quote reserve plus virtual_quote_reserves; the
 * reserves alone read ~20% under what buyers pay. It sits after variable
 * fields, so it is found by walking the layout; null on events without it.
 */
function virtualQuote(d: Buffer, isBuy: boolean): bigint | null {
  try {
    if (!isBuy) return d.length >= 408 ? i128(d, 392) : null;
    // track_volume, total_unclaimed/claimed, current_sol_volume, last_update_timestamp,
    // min_base_amount_out, then ix_name (u32 length + bytes)
    let o = 401;
    if (d.length < o + 4) return null;
    o += 4 + d.readUInt32LE(o);
    o += 32; // cashback and buyback fee bps and amounts
    return d.length >= o + 16 ? i128(d, o) : null;
  } catch {
    return null;
  }
}
function events(logs: readonly string[], disc: Buffer, minLen: number): Buffer[] {
  const out: Buffer[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    const d = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    if (d.length >= minLen && d.subarray(0, 8).equals(disc)) out.push(d);
  }
  return out;
}

setInterval(() => {
  if (buf.length) appendFileSync(OUT, buf.join("\n") + "\n");
  buf = [];
  const now = Date.now();
  for (const [m, until] of tracked) if (now > until) tracked.delete(m);
  for (const [p, v] of pools) if (now > v.until) pools.delete(p);
  // a public socket can go quiet without closing; exit and let the wrapper restart it
  if (now - lastMsg > SILENCE_MS) {
    console.error(new Date().toISOString(), "no logs for 90s — exiting for a restart");
    process.exit(2);
  }
}, 2000);
setInterval(
  () => console.log(new Date().toISOString(), JSON.stringify(n), "tracked", tracked.size, "pools", pools.size),
  60_000,
);

conn.onLogs(
  new PublicKey(PUMP),
  (logs: { err: unknown; logs: string[] }, ctx: { slot: number }) => {
    lastMsg = Date.now();
    if (logs.err) return;
    const t = Date.now();
    const c = decodePumpCreateEvent(logs.logs);
    if (c && !tracked.has(c.mint)) {
      tracked.set(c.mint, t + TRACK_MS);
      n.creates++;
      write({
        k: "c", t, s: ctx.slot, m: c.mint, dev: c.user, mh: c.isMayhemMode ? 1 : 0, q: c.quoteMint,
        vsr: c.virtualSolReserves, vtr: c.virtualTokenReserves,
      });
    }
    for (const tr of decodeTradeEvents(logs.logs)) {
      if (!tracked.has(tr.mint)) {
        if (tr.virtualTokenReserves === 0n || (INITIAL_VTR - tr.virtualTokenReserves) * 100n < CURVE_SALE * BigInt(FOLLOW_FILL_PCT)) continue;
        tracked.set(tr.mint, t + FOLLOW_MS);
      } else if (tracked.get(tr.mint)! < t + FOLLOW_MS
        && (INITIAL_VTR - tr.virtualTokenReserves) * 100n >= CURVE_SALE * BigInt(FOLLOW_FILL_PCT)) {
        tracked.set(tr.mint, t + FOLLOW_MS);
      }
      n.trades++;
      write({
        k: "t", t, s: ctx.slot, m: tr.mint, u: tr.user, b: tr.isBuy ? 1 : 0,
        sol: tr.solAmount, tok: tr.tokenAmount, vsr: tr.virtualSolReserves, vtr: tr.virtualTokenReserves,
      });
    }
    for (const m of decodeCompleteEvents(logs.logs)) {
      n.completes++;
      write({ k: "x", t, s: ctx.slot, m });
    }
    // CompletePumpAmmMigrationEvent: user, mint, mint_amount, sol_amount, pool_migration_fee,
    // bonding_curve, timestamp, pool
    for (const d of events(logs.logs, MIGRATION_EVENT, 168)) {
      const m = key(d, 40);
      const pool = key(d, 136);
      pools.set(pool, { mint: m, until: t + FOLLOW_MS });
      n.migrations++;
      write({ k: "g", t, s: ctx.slot, m, pool, tok: d.readBigUInt64LE(72), sol: d.readBigUInt64LE(80) });
    }
  },
  "processed",
);

// BuyEvent / SellEvent share their first fields: timestamp, base amount, limit,
// user reserves (2), pool base and quote reserves, quote amount, fees (4),
// quote with/without lp fee, user quote amount, pool, user
conn.onLogs(
  new PublicKey(PUMP_AMM),
  (logs: { err: unknown; logs: string[] }, ctx: { slot: number }) => {
    lastMsg = Date.now();
    if (logs.err || pools.size === 0) return;
    const t = Date.now();
    for (const [disc, isBuy] of [[AMM_BUY_EVENT, 1], [AMM_SELL_EVENT, 0]] as const) {
      for (const d of events(logs.logs, disc, 184)) {
        const pool = key(d, 120);
        const p = pools.get(pool);
        if (!p) continue;
        n.swaps++;
        write({
          k: "a", t, s: ctx.slot, m: p.mint, u: key(d, 152), b: isBuy,
          tok: d.readBigUInt64LE(16), sol: d.readBigUInt64LE(112),
          pb: d.readBigUInt64LE(48), pq: d.readBigUInt64LE(56), vq: virtualQuote(d, isBuy === 1),
        });
      }
    }
  },
  "processed",
);
console.log("recording to", OUT, "from", SOURCE);
