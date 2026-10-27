import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childLogger } from "../utils/logger.js";

const log = childLogger("copy-wallets");
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** wallet address → its name in the list ("" when unnamed) */
export type CopyWallets = ReadonlyMap<string, string>;

/**
 * The wallets the copy entry mode follows, from a JSON list of {address, name}
 * (a wallet tracker's export reduced to those two fields). A missing or broken
 * file leaves the list empty, so copy mode never trades instead of crashing.
 */
export function loadCopyWallets(file: string): CopyWallets {
  const path = isAbsolute(file) ? file : resolve(REPO_ROOT, file);
  try {
    const list = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(list)) throw new Error("not a JSON list");
    const wallets = new Map<string, string>();
    for (const w of list as Array<{ address?: unknown; name?: unknown }>) {
      if (typeof w?.address === "string" && w.address.length >= 32) {
        wallets.set(w.address, typeof w.name === "string" ? w.name : "");
      }
    }
    log.info({ path, wallets: wallets.size }, "copy wallets loaded");
    return wallets;
  } catch (err) {
    log.error({ path, err: (err as Error).message }, "could not read the copy wallets — copy mode will not trade");
    return new Map();
  }
}
