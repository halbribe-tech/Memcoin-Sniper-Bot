"""Replay recorded pump.fun launches: features at entry time T, and the bot's exits on the real trade path."""
import json, sys
from collections import defaultdict

SOL_USD = 108.0
SIZE_USD = 100.0
FEE = 0.0125  # pump.fun trade fee (protocol + creator), each side
START_P = 30 / 1_073_000_000  # standard curve start, SOL per token
SUPPLY = 1e15  # raw token units


def load(path):
    creates, trades = {}, defaultdict(list)
    last_t = 0
    for line in open(path):
        try:
            e = json.loads(line)
        except Exception:
            continue
        last_t = max(last_t, e["t"])
        if e["k"] == "c":
            creates[e["m"]] = e
        else:
            trades[e["m"]].append(e)
    return creates, trades, last_t


def price(vsr, vtr):
    return (int(vsr) / 1e9) / (int(vtr) / 1e6)


def buy_tokens(vsr, vtr, sol):
    vsr, vtr = int(vsr) / 1e9, int(vtr)
    k = vsr * vtr
    return vtr - k / (vsr + sol * (1 - FEE))  # raw token units


def sell_sol(vsr, vtr, tokens):
    vsr, vtr = int(vsr) / 1e9, int(vtr)
    k = vsr * vtr
    return (vsr - k / (vtr + tokens)) * (1 - FEE)


def features(c, tr, T):
    """Everything the bot could know T seconds after the create."""
    t0, s0, dev = c["t"], c["s"], c["dev"]
    p0 = price(c["vsr"], c["vtr"])
    cut = t0 + T * 1000
    seen = [x for x in tr if x["t"] <= cut]
    launch = [x for x in seen if x["s"] == s0 and x["u"] == dev]
    pl = price(launch[-1]["vsr"], launch[-1]["vtr"]) if launch else p0
    if seen:
        last = seen[-1]
        pT, vsr, vtr = price(last["vsr"], last["vtr"]), last["vsr"], last["vtr"]
    else:
        pT, vsr, vtr = p0, c["vsr"], c["vtr"]
    peak = max([price(x["vsr"], x["vtr"]) for x in seen] + [p0])
    hold = defaultdict(float)
    dev_bought = dev_held = 0.0
    launch_buyers = {}
    buys = sells = 0
    buy_sol = sell_sol_ = 0.0
    r_buys = r_sells = 0
    r_net = 0.0
    r_users = set()
    users = set()
    for x in seen:
        tok, sol = int(x["tok"]), int(x["sol"]) / 1e9
        sign = 1 if x["b"] else -1
        hold[x["u"]] += sign * tok
        users.add(x["u"])
        if x["b"]:
            buys += 1; buy_sol += sol
        else:
            sells += 1; sell_sol_ += sol
        if x["t"] > cut - 30_000:
            r_users.add(x["u"])
            r_net += sign * sol
            if x["b"]: r_buys += 1
            else: r_sells += 1
        if x["u"] == dev:
            if x["b"]: dev_bought += tok
            dev_held += sign * tok
        elif x["u"] in launch_buyers:
            launch_buyers[x["u"]] += sign * tok
        elif x["b"] and x["s"] <= s0 + 1:
            launch_buyers[x["u"]] = tok
    holders = sorted((v for v in hold.values() if v > 0), reverse=True)
    return dict(
        pT=pT, vsr=vsr, vtr=vtr, p0=p0,
        gain_launch=(pT / pl - 1) * 100,
        gain_start=(pT / p0 - 1) * 100,
        dd_peak=(1 - pT / peak) * 100,
        buys=buys, sells=sells, users=len(users),
        net_sol=buy_sol - sell_sol_, buy_sol=buy_sol,
        r_buys=r_buys, r_sells=r_sells, r_net=r_net, r_users=len(r_users),
        dev_bought=dev_bought / SUPPLY * 100,
        dev_sold=((dev_bought - max(dev_held, 0)) / dev_bought * 100) if dev_bought > 0 else 0.0,
        launch_held=sum(max(v, 0) for v in launch_buyers.values()) / SUPPLY * 100,
        top1=(holders[0] / SUPPLY * 100) if holders else 0.0,
        top10=sum(holders[:10]) / SUPPLY * 100,
        last_age=(cut - seen[-1]["t"]) / 1000 if seen else T,
    )


def simulate(c, tr, T, exits):
    """The bot's exits on the real path after a $100 buy at T. Returns pnl in USD."""
    f = features(c, tr, T)
    t_in = c["t"] + T * 1000
    sol_in = exits.get("size_usd", SIZE_USD) / SOL_USD
    tokens0 = buy_tokens(f["vsr"], f["vtr"], sol_in)
    if tokens0 <= 0:
        return None
    entry = sol_in / tokens0  # SOL per raw token, impact and fee included
    left = tokens0
    got = 0.0
    tp = exits["tp"]  # [(gain%, sell% of initial)]
    hit = [False] * len(tp)
    peak_pct = 0.0
    trail_armed = False
    floor_since = None
    p0 = f["p0"]
    vsr, vtr = f["vsr"], f["vtr"]
    after = [x for x in tr if x["t"] > t_in]
    for x in after:
        age = (x["t"] - t_in) / 1000
        if (age >= exits["time_min"] * 60 and peak_pct < 50) or (exits.get("hard_min") and age >= exits["hard_min"] * 60):
            break
        vsr, vtr = x["vsr"], x["vtr"]
        mark = (int(vsr) / 1e9) / int(vtr)
        pct = (mark / entry - 1) * 100
        # the 30-minute window closes before this trade
        if age >= exits["time_min"] * 60 and peak_pct < 50:
            break
        if exits.get("hard_min") and age >= exits["hard_min"] * 60:
            break
        peak_pct = max(peak_pct, pct)
        if peak_pct >= exits["trail_arm"]:
            trail_armed = True
        stop = 0.0 if (exits["be"] and hit[0]) else exits["sl"]
        if pct <= stop:
            got += sell_sol(vsr, vtr, left); left = 0; break
        if trail_armed and (1 + pct / 100) <= (1 + peak_pct / 100) * (1 - exits["trail"] / 100):
            got += sell_sol(vsr, vtr, left); left = 0; break
        for i in range(len(tp) - 1, -1, -1):
            if not hit[i] and pct >= tp[i][0]:
                for j in range(i + 1):
                    if not hit[j]:
                        hit[j] = True
                        q = min(left, tokens0 * tp[j][1] / 100)
                        got += sell_sol(vsr, vtr, q); left -= q
                break
        if exits["dead_min"] > 0:
            p = price(vsr, vtr)
            if p <= p0 * 1.02:
                floor_since = floor_since or x["t"]
                if x["t"] - floor_since >= exits["dead_min"] * 60_000:
                    got += sell_sol(vsr, vtr, left); left = 0; break
            else:
                floor_since = None
        if left <= 0:
            break
    if left > 0:
        got += sell_sol(vsr, vtr, left)
    return (got - sol_in) * SOL_USD, f, max(hit + [False]) and hit[0]


DEFAULT_EXITS = dict(tp=[(50, 25), (100, 25), (300, 25), (900, 15)], sl=-40, be=True, trail_arm=200, trail=30,
                     dead_min=3, time_min=30)


def universe(creates, trades, last_t, T, horizon_min=35):
    """Launches the bot would consider: SOL-paired, not Mayhem, fully observed after entry."""
    out = []
    for m, c in creates.items():
        if c["mh"] or c["q"] not in ("11111111111111111111111111111111", "So11111111111111111111111111111111111111112"):
            continue
        if c["t"] + T * 1000 + horizon_min * 60_000 > last_t:
            continue
        out.append((c, sorted(trades.get(m, []), key=lambda x: (x["s"], x["t"]))))
    return out


if __name__ == "__main__":
    creates, trades, last_t = load(sys.argv[1])
    for T in (30, 60, 90):
        u = universe(creates, trades, last_t, T)
        res = [simulate(c, tr, T, DEFAULT_EXITS) for c, tr in u]
        res = [r for r in res if r]
        pnl = [r[0] for r in res]
        print(f"T={T}s  launches={len(u)}  buy-all pnl/trade={sum(pnl)/max(len(pnl),1):.2f}$  TP1 rate={sum(r[2] for r in res)/max(len(res),1)*100:.1f}%")
