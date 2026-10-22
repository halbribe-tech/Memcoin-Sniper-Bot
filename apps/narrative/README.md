# @sniperbot/narrative — Narrativ-Scorer

Bewertet jeden neuen Launch (Name, Ticker, Beschreibung, Socials) gegen die aktuell heißen
Memecoin-Narrative und schreibt das Ergebnis nach Redis:

```
narrative:<mint>  →  JSON NarrativeScore   (TTL NARRATIVE_TTL_SEC, Standard 1800 s)
```

Der Engine-Filter `narrative` (apps/engine/src/filters/narrative.ts) liest diesen Key beim Verdict
mit einem einzigen GET (max. 150 ms). Im Shadow-Modus (Standard) hat er Gewicht 0 und lehnt nie ab:
er wird nur in `FilterResult` gespeichert, damit Dashboard und Report ihn auswerten können.

## Ablauf pro Launch

1. **fast** (Millisekunden nach `channel:new-pools`): Name + Ticker gegen die Meta-Liste.
2. **metadata** (≤ `NARRATIVE_METADATA_TIMEOUT_MS`): Metadata-JSON (IPFS, gleiche sichere Fetch-Regeln
   wie die Engine: nur öffentliches https, keine Redirects, max. 200 KB) → Beschreibung, X-Link,
   Website, Telegram. Neu bewertet und überschrieben.
3. **llm** (optional): nur wenn Stufe 2 ≥ `NARRATIVE_LLM_MIN_FAST_SCORE`. Beliebiger
   OpenAI-kompatibler Endpoint. Ergebnis wird mit `NARRATIVE_LLM_WEIGHT` eingemischt.

Breakout-Entries werden typischerweise 8–20 s nach dem Launch bewertet; bis dahin liegt meist
Stufe 2 oder 3 vor. Fehlt der Key, meldet der Filter `skip` und wartet nie.

## Score (0–100)

| Baustein | Punkte |
|---|---|
| Basis | 15 |
| Theme-Treffer × effektive Stärke | bis 65 (0,65 × Treffer(0–1) × Stärke × Frische × Neuheit) |
| Kopie eines aktuellen Gewinner-Tickers | +10 |
| X-Link / X-Post-Link in den Metadaten | +8 / +12 |
| Website / Telegram | +3 / +2 |
| Sättigung (> `NARRATIVE_SATURATION_FREE` Launches gleiches Theme in 1 h) | −1,5 je Launch, max. −25 |

Treffer: Ticker = Keyword oder Name enthält Keyword als Wort (1,0) · Teilstring ab 4 Zeichen (0,85) ·
Tippfehler/Varianten ab 5 Zeichen, Ähnlichkeit ≥ 0,8 (≈0,6) · nur in der Beschreibung (0,55/0,45) ·
Ticker steht in `exampleTickers` (0,9). Keywords unter 3 Zeichen zählen nur als ganzes Wort.
CJK-Keywords (Chinesisch/Japanisch/Koreanisch) zählen auch als Teilstring.

Frische: halbiert sich alle `NARRATIVE_FRESHNESS_HALFLIFE_H` Stunden seit `lastSeen`, Untergrenze 0,5.
Neuheit: Themes mit `firstSeen` in den letzten 12 h ×1,15.
Tier: S ≥ 80 · A ≥ 65 · B ≥ 50 · C ≥ 35 · D darunter.

## Meta-Quellen (werden zusammengeführt; bei gleicher `id` gewinnt Datei > URL > Self)

- **Datei** `NARRATIVE_METAS_FILE` (Standard `apps/narrative/data/metas.json`, relativ zum Repo-Root).
  Wird alle 2 s auf Änderungen geprüft und neu geladen. Am besten atomar ersetzen
  (in temporäre Datei schreiben, dann `mv`). Ungültige Datei → letzte gültige Version bleibt.
- **URL** `NARRATIVE_METAS_URL` (optional, z. B. Raw-URL eines privaten Gists), alle
  `NARRATIVE_METAS_POLL_SEC` Sekunden, ETag-fähig, optional `Authorization: Bearer NARRATIVE_METAS_URL_TOKEN`.
- **Self** (Fallback, `NARRATIVE_SELF_SOURCE=true`): eigene Gewinner aus Postgres der letzten
  `NARRATIVE_SELF_LOOKBACK_H` Stunden (geschlossene Positionen mit Peak ≥ `NARRATIVE_SELF_MIN_GAIN_PCT` %
  oder Gewinn). Deren Ticker → Gewinner-Ticker (Copycat-Signal); Namenswörter, die ≥ 2 Gewinner teilen,
  → Themes `self:<wort>`.

## metas.json — Schema (version 1)

```jsonc
{
  "version": 1,                         // Pflicht, immer 1
  "generatedAt": "2026-10-22T17:00:00Z",// Pflicht, ISO-Zeit
  "source": "narrativ-scanner",         // optional, frei
  "example": false,                     // optional; true = Beispieldaten
  "themes": [
    {
      "id": "ai-agents",                // Pflicht, stabil über Updates hinweg
      "name": "AI Agents",              // Pflicht, Anzeigename (Dashboard/Report)
      "keywords": ["ai agent", "agent"],// Pflicht, ≥ 1; Wörter/Phrasen, beliebige Schrift
      "aliases": ["agi", "sentient"],   // optional; zählen wie keywords
      "strength": 70,                   // Pflicht, 0–100: wie heiß das Narrativ JETZT ist
      "firstSeen": "2026-10-21T08:00:00Z", // Pflicht: wann das Narrativ aufkam
      "lastSeen": "2026-10-22T16:30:00Z",  // optional (sonst generatedAt): zuletzt als heiß bestätigt
      "expiresAt": "2026-10-29T00:00:00Z", // optional/null: danach ignoriert
      "exampleTickers": ["AGENT"],      // optional: Ticker, die das Narrativ tragen
      "xLinks": ["https://x.com/..."],  // optional: Belege (nur Doku, nicht bewertet)
      "notes": "…"                      // optional
    }
  ],
  "winnerTickers": [                    // optional: aktuelle Gewinner (Copycat-Signal)
    { "ticker": "AGENT", "mint": "…", "seenAt": "2026-10-22T15:10:00Z", "note": "…" }
  ]
}
```

Beispiel: `metas.example.json` (ausdrücklich nur Beispieldaten).

## Befehle

```bash
pnpm dev:narrative                       # Scorer starten (neben dev:engine)
pnpm narrative:report -- --hours 72      # Trefferquote je Score-Bucket (--mode paper|live, --min 50)
pnpm narrative:score -- "Dog Wif Hat" WIF "optional description"   # Einzelnen Namen testen
psql "$DATABASE_URL" -f apps/narrative/scripts/report.sql          # gleicher Report als SQL
pnpm --filter @sniperbot/narrative test
```
