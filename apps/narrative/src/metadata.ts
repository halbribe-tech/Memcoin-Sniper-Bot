import { childLogger } from "./logger.js";

const log = childLogger("metadata");

const MAX_BODY_BYTES = 200_000;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5000;

// Same gateway handling as the engine's feeds/token-metadata.ts: ipfs.io & co.
// stopped serving content, most pump.fun metadata still links there.
const IPFS_GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/"];
const RETIRED_GATEWAYS = new Set(["ipfs.io", "dweb.link", "w3s.link", "cloudflare-ipfs.com", "gateway.ipfs.io"]);

export interface LaunchMetadata {
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

function ipfsPath(url: string): string | null {
  if (url.startsWith("ipfs://")) return url.slice("ipfs://".length).replace(/^ipfs\//, "");
  try {
    const u = new URL(url);
    if (RETIRED_GATEWAYS.has(u.hostname) && u.pathname.startsWith("/ipfs/")) return u.pathname.slice("/ipfs/".length) + u.search;
  } catch {
    // not a URL
  }
  return null;
}

function candidates(url: string): string[] {
  const path = ipfsPath(url);
  if (path) return IPFS_GATEWAYS.map((g) => g + path);
  return url.startsWith("https://") ? [url] : [];
}

/** Launch-controlled links: only public https hosts, no localhost, private names or bare IPs. */
export function isPublicHttps(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  return host.includes(".");
}

const str = (v: unknown, max = 600): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export function pickMetadata(json: unknown): LaunchMetadata {
  const j = (json ?? {}) as Record<string, unknown>;
  const ext = (j.extensions ?? {}) as Record<string, unknown>;
  return {
    description: str(j.description),
    twitter: str(j.twitter ?? ext.twitter, 300),
    telegram: str(j.telegram ?? ext.telegram, 300),
    website: str(j.website ?? j.external_url ?? ext.website, 300),
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return undefined;
    return JSON.parse(text);
  } catch (err) {
    log.debug({ url, err: (err as Error).message }, "metadata fetch failed");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<string, { data: LaunchMetadata | null; at: number }>();

/** Description and socials from the launch's metadata JSON; null when it could not be read in time. */
export async function fetchLaunchMetadata(uri: string | undefined, timeoutMs: number): Promise<LaunchMetadata | null> {
  if (!uri) return null;
  const hit = cache.get(uri);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const deadline = Date.now() + timeoutMs;
  let data: LaunchMetadata | null = null;
  for (const url of candidates(uri)) {
    const left = deadline - Date.now();
    if (left <= 50) break;
    if (!isPublicHttps(url)) continue;
    const json = await fetchJson(url, left);
    if (json !== undefined) {
      data = pickMetadata(json);
      break;
    }
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(uri, { data, at: Date.now() });
  return data;
}

/** A link to an X / Twitter account or post. */
export function isXLink(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^mobile\./, "");
    return (host === "x.com" || host === "twitter.com") && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function isXPost(url: string | undefined): boolean {
  return isXLink(url) && /\/status\/\d+/.test(url ?? "");
}
