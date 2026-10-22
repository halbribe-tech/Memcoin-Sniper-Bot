# Strategy research on recorded launches

Paper results take hours to say anything: the bot opens ~15 positions an hour. These tools
record every new pump.fun launch with all of its trades, then replay any entry rule and exit
rule over thousands of them at once, on the real price path, gaps included.

| File | What it does |
| --- | --- |
| `recorder.ts` | Subscribes to pump.fun's logs on Helius (standard WebSocket, no RPC calls) and appends every create and every trade of a coin's first 40 minutes to a JSONL file. |
| `sim.py` | Features at an entry time (curve gain over launch, buyers, net SOL in the last 30s, dev sold, launch-slot holdings, top holders, drawdown from peak) and the bot's exits replayed on the trades that followed: TP ladder, stop-loss, break-even after TP1, trailing stop, dead coin, time exits. Fees and curve price impact on both sides. |
| `search2.py` | Entries at a fixed time (30/60/90s) or at a breakout (first trade at 1.5–4× the start price, 5s+ after the create, 2s latency), under several exit sets, searched over pairs of feature thresholds. Ranks by the worse of two time halves. |
| `oos.py` | Scores rules fixed in a `preregistered_*.json` only on launches created after the file's timestamp. |

```bash
# record (leave running for hours; ~40 MB an hour)
./apps/engine/node_modules/.bin/tsx research/recorder.ts research/launches.jsonl

# search, then test a fixed set of rules on launches recorded after it
python3 -m venv research/.venv && research/.venv/bin/pip install numpy
research/.venv/bin/python research/search2.py research/launches.jsonl 60
research/.venv/bin/python research/oos.py research/launches.jsonl research/preregistered_round2.json
```

## Findings, night of 2026-10-21 (10,500 launches)

- Only SOL-paired, non-Mayhem launches count. A launch needs 35 minutes after entry to be scored.
- A $100 round trip on a fresh curve costs about 8%: ~1.25% fee each way and ~6% of price impact.
  $25 costs about 3%.
- 87% of launches peak before 90s, most of them in the create's own slot (the dev's buy).
- Every entry at a fixed 30–120s lost money, under every filter pair and exit set tried.
- The bot's settings at the time (90s, curve-momentum ≥20%, bundle check, top holders, TP
  50/100/300/900, SL −40%) lost 22% and 11% per trade on two sets of fresh launches, and 20% per
  trade in live paper trading (40 trades).
- Breakout entries were the least bad. The 2.5× breakout with the dev still holding came out at
  −1.1% (round 1) and −1.1% / +0.7% (round 2, two exit sets) on fresh launches. No rule was
  reliably positive.
- In live paper trading the 2× breakout rule (ENTRY_MODE=breakout, $25, TP 30/50, SL −20, trail
  30/20, 10-minute exit, Breakout preset) lost 11% per trade over 19 trades. Its stop-losses
  filled near −50%, because the curve gaps through the stop between 3-second price polls.
