"""Entries by time or by breakout, features at entry, outcomes under several exits; search feature pairs."""
import itertools, pickle, sys, importlib.util, time
import numpy as np

spec = importlib.util.spec_from_file_location("sim", sys.argv[0].replace("search2.py", "sim.py"))
sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)
SOLQ = ("11111111111111111111111111111111", "So11111111111111111111111111111111111111112")
D = sim.DEFAULT_EXITS
SIZE = 25
EXITS = {
    "bot default": D,
    "TP1 40/100 SL-20": {**D, "tp": [(40, 100)], "sl": -20},
    "TP1 25/100 SL-15": {**D, "tp": [(25, 100)], "sl": -15},
    "TP 30/50 run, SL-20, trail 30/20": {**D, "tp": [(30, 50), (300, 25), (900, 15)], "sl": -20, "trail_arm": 30, "trail": 20},
    "moonbag TP100/50 SL-30 trail 50/30": {**D, "tp": [(100, 50)], "sl": -30, "trail_arm": 50, "trail": 30},
    "TP1 50/50 SL-30 hard10": {**D, "tp": [(50, 50), (150, 25), (400, 25)], "sl": -30, "hard_min": 10},
    "TP 20/50 run, SL-15, trail 20/15": {**D, "tp": [(20, 50), (200, 25), (600, 15)], "sl": -15, "trail_arm": 20, "trail": 15},
    "TP 30/50 run, SL-20, trail 30/20, hard10": {**D, "tp": [(30, 50), (300, 25), (900, 15)], "sl": -20, "trail_arm": 30, "trail": 20, "hard_min": 10},
}
TRIGGERS = [("T", 30), ("T", 60), ("T", 90), ("L", 1.5), ("L", 2), ("L", 2.5), ("L", 3), ("L", 4)]
FEATS = ["users", "r_buys", "r_sells", "r_net", "dev_sold", "dev_bought", "launch_held", "top1", "top10", "dd_peak",
         "gain_launch", "buy_sol", "age"]


def entries(creates, trades, last):
    out = {tg: [] for tg in TRIGGERS}
    for m, c in creates.items():
        if c["mh"] or c["q"] not in SOLQ:
            continue
        tr = sorted(trades.get(m, []), key=lambda x: (x["s"], x["t"]))
        p0 = sim.price(c["vsr"], c["vtr"])
        for kind, v in TRIGGERS:
            if kind == "T":
                T = v
            else:
                hit = next((x for x in tr if x["s"] > c["s"] and x["t"] - c["t"] >= 5000
                            and sim.price(x["vsr"], x["vtr"]) >= v * p0 and x["t"] - c["t"] <= 20 * 60_000), None)
                if not hit:
                    continue
                T = (hit["t"] - c["t"]) / 1000 + 2.0
            if c["t"] + T * 1000 + 35 * 60_000 > last:
                continue
            out[(kind, v)].append((c, tr, T))
    return out


def build(path):
    creates, trades, last = sim.load(path)
    E = entries(creates, trades, last)
    data = {}
    for tg, rows in E.items():
        rows.sort(key=lambda r: r[0]["t"])
        F, P = [], {k: [] for k in EXITS}
        for c, tr, T in rows:
            f = sim.features(c, tr, T); f["age"] = T
            F.append([f[k] for k in FEATS])
            for name, ex in EXITS.items():
                r = sim.simulate(c, tr, T, {**ex, "size_usd": SIZE})
                P[name].append((r[0] if r else 0.0) / SIZE * 100)
        data[tg] = (np.array(F), {k: np.array(v) for k, v in P.items()})
    return data, len(creates)


def conditions(F):
    conds = []
    for j, k in enumerate(FEATS):
        x = F[:, j]
        for q in np.unique(np.quantile(x, [0.2, 0.4, 0.6, 0.8])):
            conds.append((f"{k}>={q:.2f}", x >= q))
            conds.append((f"{k}<{q:.2f}", x < q))
    return conds


if __name__ == "__main__":
    t0 = time.time()
    data, ncreates = build(sys.argv[1])
    pickle.dump(data, open(sys.argv[1] + ".cache.pkl", "wb"))
    print(f"built {time.time()-t0:.0f}s from {ncreates} launches:", {f"{k}{v}": len(data[(k, v)][0]) for k, v in TRIGGERS})
    MIN_N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    results = []
    for tg, (F, P) in data.items():
        n = len(F)
        if n < 2 * MIN_N:
            continue
        cut = int(n * 0.5)
        first, second = np.arange(n) < cut, np.arange(n) >= cut
        conds = [("all", np.ones(n, bool))] + conditions(F)
        for ename, p in P.items():
            for (a, ma), (b, mb) in itertools.combinations(conds, 2):
                m = ma & mb
                m1, m2 = m & first, m & second
                n1, n2 = int(m1.sum()), int(m2.sum())
                if n1 < MIN_N or n2 < MIN_N:
                    continue
                r1, r2 = p[m1].mean(), p[m2].mean()
                results.append((min(r1, r2), r1, r2, n1, n2, (p[m] > 0).mean() * 100, f"{tg[0]}{tg[1]}", ename, f"{a} & {b}"))
    results.sort(key=lambda r: -r[0])
    print(f"{len(results)} candidate rules; best by worse half (each half n≥{MIN_N}, $25 stake, % of stake):")
    for r in results[:25]:
        print(f"  worse {r[0]:+6.2f}%  h1 {r[1]:+6.2f}% (n={r[3]})  h2 {r[2]:+6.2f}% (n={r[4]})  win {r[5]:4.1f}%  {r[6]:<5} {r[7]:<34} {r[8]}")
