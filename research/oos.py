"""Evaluate the pre-registered rules only on launches created after registration."""
import json, random, sys, importlib.util
import numpy as np

here = sys.argv[0].replace("oos.py", "")
spec = importlib.util.spec_from_file_location("s2", here + "search2.py")
s2 = importlib.util.module_from_spec(spec)
sys_argv = sys.argv; sys.argv = [here + "search2.py"]; spec.loader.exec_module(s2); sys.argv = sys_argv
sim = s2.sim

reg = json.load(open(sys.argv[2] if len(sys.argv) > 2 else here + "preregistered_round2.json"))
creates, trades, last = sim.load(sys.argv[1])
fresh = {m: c for m, c in creates.items() if c["t"] > reg["registered_at_ms"]}
E = s2.entries(fresh, trades, last)
print(f"launches created after registration: {len(fresh)}; usable entries:", {f"{k}{v}": len(E[(k, v)]) for k, v in s2.TRIGGERS})

def boot_ci(p, n=2000):
    if len(p) < 3: return (float("nan"), float("nan"))
    means = sorted(np.mean(random.choices(p, k=len(p))) for _ in range(n))
    return means[int(n * .05)], means[int(n * .95)]

for rule in reg["rules"]:
    rows = E[tuple(rule["trigger"])]
    for size in (25, 100):
        ex = {**s2.EXITS[rule["exits"]], "size_usd": size}
        pnl = []
        for c, tr, T in rows:
            f = sim.features(c, tr, T); f["age"] = T
            env = dict(f, max=max)
            if not eval(rule["filter"], {"__builtins__": {}}, env):
                continue
            r = sim.simulate(c, tr, T, ex)
            pnl.append((r[0] if r else 0.0) / size * 100)
        p = np.array(pnl)
        lo, hi = boot_ci(list(p))
        print(f"  {rule['id']:<4} ${size:>3}  n={len(p):>3}  mean {p.mean() if len(p) else float('nan'):+6.2f}%  "
              f"90% CI [{lo:+6.2f}, {hi:+6.2f}]  win {((p>0).mean()*100 if len(p) else 0):4.1f}%   {rule['filter']} | {rule['exits']}")
