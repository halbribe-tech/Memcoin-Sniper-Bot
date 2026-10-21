import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "./common.js";

// sha256("event:CreateEvent")[0..8], as in pump's IDL
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const PROGRAM_DATA = "Program data: ";
// bonding_curve.quote_mint for a SOL-paired coin
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** What pump.fun's CreateEvent says about a new coin, read from the create tx's logs. */
export interface PumpCreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  // absent on events from the legacy `create`, which supports neither
  isMayhemMode: boolean;
  quoteMint: string;
}

/**
 * The CreateEvent in a pump.fun create (or create_v2) transaction's logs, or
 * null when there is none. Everything the detector needs is in it, so a
 * launch costs no RPC call, and it works on every transaction version.
 */
export function decodePumpCreateEvent(logs: readonly string[]): PumpCreateEvent | null {
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    const data = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    if (data.length < 8 || !data.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;
    try {
      return readCreateEvent(data);
    } catch {
      return null;
    }
  }
  return null;
}

function readCreateEvent(data: Buffer): PumpCreateEvent {
  let o = 8;
  const str = () => {
    const n = data.readUInt32LE(o);
    o += 4;
    const v = data.toString("utf8", o, o + n);
    o += n;
    return v;
  };
  const key = () => {
    if (o + 32 > data.length) throw new RangeError("truncated pubkey");
    const v = new PublicKey(data.subarray(o, o + 32)).toBase58();
    o += 32;
    return v;
  };
  const u64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };

  const name = str();
  const symbol = str();
  const uri = str();
  const mint = key();
  const bondingCurve = key();
  const user = key();
  const creator = key();
  const timestamp = Number(data.readBigInt64LE(o));
  o += 8;
  const virtualTokenReserves = u64();
  const virtualSolReserves = u64();
  const realTokenReserves = u64();
  const tokenTotalSupply = u64();
  o += 32; // token_program

  // create_v2 appends is_mayhem_mode, is_cashback_enabled and quote_mint
  const isMayhemMode = o < data.length ? data[o] === 1 : false;
  o += 2;
  const quoteMint = o + 32 <= data.length ? key() : DEFAULT_PUBKEY;

  return {
    name,
    symbol,
    uri,
    mint,
    bondingCurve,
    user,
    creator,
    timestamp,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    tokenTotalSupply,
    isMayhemMode,
    quoteMint,
  };
}

/** Traded against SOL, rather than USDC or another pump coin. */
export function isSolPaired(e: Pick<PumpCreateEvent, "quoteMint">): boolean {
  return e.quoteMint === DEFAULT_PUBKEY || e.quoteMint === SOL_MINT;
}

export type LaunchSkipReason = "mayhem" | "not-sol-paired";

/** Why a launch is dropped before it reaches the filters, or null to keep it. */
export function launchSkipReason(
  e: Pick<PumpCreateEvent, "isMayhemMode" | "quoteMint">,
  opts: { skipMayhem: boolean; solPairsOnly: boolean },
): LaunchSkipReason | null {
  if (opts.skipMayhem && e.isMayhemMode) return "mayhem";
  if (opts.solPairsOnly && !isSolPaired(e)) return "not-sol-paired";
  return null;
}
