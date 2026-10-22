/** Words that say nothing about a narrative. */
export const STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "to", "and", "or", "for", "is", "it", "my", "your", "this", "that",
  "coin", "token", "sol", "solana", "pump", "fun", "meme", "memecoin", "official", "inu", "new", "real",
  "ca", "x", "com", "www", "https", "http", "dev", "cto", "first", "only", "just", "get", "with", "by",
]);

/** Lowercase letters and digits of any script, single spaces; camelCase is split first. */
export function normalize(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokens(s: string | undefined | null): string[] {
  const n = normalize(s);
  return n ? n.split(" ") : [];
}

export function compact(s: string | undefined | null): string {
  return normalize(s).replace(/ /g, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Does the normalized text contain the normalized phrase as whole words? */
export function hasPhrase(text: string, phrase: string): boolean {
  if (!text || !phrase) return false;
  return (" " + text + " ").includes(" " + phrase + " ");
}
