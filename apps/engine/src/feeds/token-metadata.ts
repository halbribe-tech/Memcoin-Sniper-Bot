import { childLogger } from "../utils/logger.js";

const log = childLogger("token-metadata");

const FETCH_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 200_000;
const HIT_TTL_MS = 60 * 60_000;
const MISS_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;

const cache = new Map<string, { image: string | null; at: number }>();
const inflight = new Map<string, Promise<string | null>>();

// ipfs.io, dweb.link and w3s.link stopped serving content in 2026 ("switching to a
// service worker gateway only"), yet most pump.fun metadata still links to ipfs.io.
const IPFS_GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/"];
const RETIRED_GATEWAYS = new Set(["ipfs.io", "dweb.link", "w3s.link", "cloudflare-ipfs.com", "gateway.ipfs.io"]);

/** The IPFS path of a link (CID and anything after it), or null when it is not an IPFS link. */
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

/** Every https URL worth trying for a link: working gateways for IPFS, the link itself otherwise. */
function candidates(url: string): string[] {
  const path = ipfsPath(url);
  if (path) return IPFS_GATEWAYS.map((g) => g + path);
  return url.startsWith("https://") ? [url] : [];
}

/**
 * The metadata link comes from whoever launched the coin, so the engine only
 * fetches public https hosts: no localhost, private ranges or bare IPs that
 * could point it at something on this machine's network.
 */
function isPublicHttps(url: string): boolean {
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

async function fetchImage(uri: string): Promise<string | null> {
  for (const url of candidates(uri)) {
    if (!isPublicHttps(url)) continue;
    const image = await imageFromMetadata(url);
    if (image !== undefined) return image;
  }
  return null;
}

/** The image named in the metadata at `url`; null when it names none, undefined when the fetch failed. */
async function imageFromMetadata(url: string): Promise<string | null | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // a redirect could lead from a public host to a private one, so none are followed
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const image = (JSON.parse(text) as { image?: unknown }).image;
    if (typeof image !== "string") return null;
    const imageUrl = candidates(image.trim())[0];
    return imageUrl && isPublicHttps(imageUrl) ? imageUrl : null;
  } catch (err) {
    log.debug({ url, err: (err as Error).message }, "metadata fetch failed");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The coin's image URL from its metadata JSON, or null. Cached; failures retry after 5 minutes. */
export async function resolveTokenImage(uri: string): Promise<string | null> {
  const hit = cache.get(uri);
  if (hit && Date.now() - hit.at < (hit.image ? HIT_TTL_MS : MISS_TTL_MS)) return hit.image;
  const pending = inflight.get(uri);
  if (pending) return pending;
  const p = fetchImage(uri)
    .then((image) => {
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(uri, { image, at: Date.now() });
      return image;
    })
    .finally(() => inflight.delete(uri));
  inflight.set(uri, p);
  return p;
}
