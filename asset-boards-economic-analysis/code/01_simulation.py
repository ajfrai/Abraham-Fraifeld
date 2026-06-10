"""
Latent Demand Revelation: a simulation of what happens to PRICE, EFFICIENCY, and
SURPLUS DISTRIBUTION when a segmented "many local markets" world is aggregated into
one national "asset board" (Zillow/LinkedIn-style), holding physical SUPPLY FIXED.

Two experiments:
  (A) Clean order-statistic mechanism on a single scarce asset (analytic + Monte Carlo).
  (B) General-equilibrium assignment market (Bertsekas auction algorithm) that yields
      market-clearing prices, so we can DECOMPOSE the price change into:
          efficiency (real surplus created by better sorting)  vs.
          transfer   (rent shifted from buyers to sellers by thicker competition).

Author: original analysis. No external data; pure simulation.
"""

import numpy as np
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

RNG = np.random.default_rng(20260610)
FIG = Path(__file__).resolve().parent.parent / "figures"
OUT = Path(__file__).resolve().parent.parent / "data"
FIG.mkdir(exist_ok=True); OUT.mkdir(exist_ok=True)

# ----------------------------------------------------------------------------
# EXPERIMENT A: order statistics on ONE scarce asset
# Selling price in a competitive/2nd-price contest = 2nd-highest valuation among
# the n buyers who can SEE the listing. Aggregation raises n -> raises price,
# for FIXED supply. This is "latent demand revelation" in its purest form.
# ----------------------------------------------------------------------------
def expA():
    ns = np.arange(1, 41)
    # Analytic: uniform[0,1] private values -> E[2nd highest of n] = (n-1)/(n+1)
    analytic = np.where(ns >= 2, (ns - 1) / (ns + 1), 0.0)
    # Monte Carlo with a realistic right-skewed (lognormal) willingness-to-pay,
    # normalized so the population mean WTP = 1.0 (so levels are comparable).
    sims = 60000
    sigma = 0.5
    mc_price = []
    mc_winner = []
    for n in ns:
        v = RNG.lognormal(mean=-0.5 * sigma**2, sigma=sigma, size=(sims, n))  # mean 1
        v.sort(axis=1)
        if n >= 2:
            mc_price.append(v[:, -2].mean())   # sale price = 2nd-highest bid
        else:
            mc_price.append(v[:, -1].mean() * 0)  # no competition, reserve only
        mc_winner.append(v[:, -1].mean())          # highest valuation (match quality)
    mc_price = np.array(mc_price); mc_winner = np.array(mc_winner)

    # Map a few illustrative "segmentation -> board" transitions
    def price_at(n):
        i = np.clip(n - 1, 0, len(ns) - 1)
        return mc_price[i]
    transitions = {}
    for (n_local, n_board, label) in [(3, 15, "local (3) -> metro board (15)"),
                                      (3, 30, "local (3) -> national board (30)"),
                                      (5, 25, "regional (5) -> national (25)")]:
        p0, p1 = price_at(n_local), price_at(n_board)
        transitions[label] = {"n_local": n_local, "n_board": n_board,
                              "price_local": round(float(p0), 4),
                              "price_board": round(float(p1), 4),
                              "pct_increase": round(float((p1 / p0 - 1) * 100), 1)}

    # Figure
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.6))
    ax[0].plot(ns, analytic, "o-", ms=3, label="Analytic, uniform values:  (n-1)/(n+1)")
    ax[0].plot(ns, mc_price, "s-", ms=3, label="Monte-Carlo, lognormal WTP (mean=1)")
    ax[0].set_xlabel("n = buyers who can SEE the listing (demand revealed)")
    ax[0].set_ylabel("Expected sale price\n(= 2nd-highest valuation)")
    ax[0].set_title("A1. Aggregating demand raises price for FIXED supply")
    ax[0].axvspan(1, 4, color="tab:green", alpha=0.08)
    ax[0].axvspan(12, 40, color="tab:red", alpha=0.06)
    ax[0].text(2.5, 0.05, "segmented\n(local)", fontsize=8, ha="center", color="green")
    ax[0].text(26, 0.05, "aggregated (board)", fontsize=8, ha="center", color="firebrick")
    ax[0].legend(fontsize=8, loc="lower right"); ax[0].grid(alpha=.3)

    # Marginal effect: how much each extra revealed bidder adds
    marg = np.diff(mc_price)
    ax[1].bar(ns[1:], marg, color="tab:purple", alpha=.7)
    ax[1].set_xlabel("n-th buyer revealed")
    ax[1].set_ylabel("Δ price from the n-th buyer")
    ax[1].set_title("A2. Diminishing returns: thin markets are most price-sensitive")
    ax[1].grid(alpha=.3)
    fig.tight_layout(); fig.savefig(FIG / "fig1_order_statistics.png", dpi=130)
    plt.close(fig)
    return {"transitions": transitions,
            "price_n3": round(float(price_at(3)), 4),
            "price_n15": round(float(price_at(15)), 4),
            "price_n30": round(float(price_at(30)), 4)}


# ----------------------------------------------------------------------------
# EXPERIMENT B: general-equilibrium assignment market
# B buyers (unit demand), H homes (unit supply, FIXED). Value of buyer i for home j:
#     a_ij = QUALITY_j  +  kappa * MATCH_ij
# QUALITY_j is a common vertical quality (everyone agrees SF > Fresno);
# MATCH_ij is idiosyncratic horizontal taste (you love a craftsman, I love a loft).
# Segmented world: market split into S islands; buyer only sees homes on her island.
# Board world: every buyer sees every home.
# We solve for competitive-equilibrium prices+assignment with the Bertsekas auction
# algorithm, then measure price, efficiency, and who captures the surplus.
# ----------------------------------------------------------------------------
def _auction_phase(val, prices, eps, max_iter=400000):
    """One eps-phase of the forward auction algorithm. val already has -inf on
    disallowed edges. Mutates/returns prices; returns assignment."""
    B, H = val.shape
    owner = -np.ones(H, dtype=int)
    assign = -np.ones(B, dtype=int)
    unassigned = list(range(B))
    guard = 0
    while unassigned and guard < max_iter:
        guard += 1
        i = unassigned.pop()
        net = val[i] - prices
        j = int(np.argmax(net))
        # Individual rationality: outside option (not buying) = 0. A buyer never
        # bids above her valuation, so prices are bounded by WTP and excess buyers
        # (theta>1) drop out at the margin -> this both is correct economics AND
        # guarantees fast termination.
        if net[j] <= 0:                              # nothing worth buying at current prices
            assign[i] = -1
            continue
        best = net[j]
        net[j] = -np.inf
        second = max(float(np.max(net)), 0.0)       # 2nd-best, floored at outside option 0
        if not np.isfinite(second):
            second = 0.0
        prices[j] += best - second + eps
        prev = owner[j]
        if prev != -1:
            assign[prev] = -1
            unassigned.append(prev)
        owner[j] = i
        assign[i] = j
    return assign, prices


def bertsekas_assignment(value, allowed, eps=0.05):
    """Max-weight assignment via a single-phase forward auction with individual
    rationality (outside option 0). Single phase avoids eps-scaling overshoot that,
    combined with IR drop-out, would spuriously price winners out. Returns
    assign_obj[i] (object index or -1) and competitive-equilibrium prices[j]
    (accurate to within eps)."""
    val = np.where(allowed, value, -1e18)
    prices = np.zeros(value.shape[1])
    assign, prices = _auction_phase(val, prices, eps, max_iter=3_000_000)
    return assign, prices


def run_market(B, H, S, kappa, board, eps=1e-3):
    """One realization. Returns dict of outcomes for the chosen regime."""
    quality = RNG.lognormal(mean=0.0, sigma=0.6, size=H)          # common vertical quality
    quality = quality / quality.mean()                            # mean 1
    match = RNG.gamma(shape=2.0, scale=0.5, size=(B, H))          # idiosyncratic, mean 1
    value = quality[None, :] + kappa * match                     # buyer i value for home j

    if board:
        allowed = np.ones((B, H), dtype=bool)
    else:
        # assign buyers and homes to S islands; visibility only within island
        b_isl = RNG.integers(0, S, size=B)
        h_isl = RNG.integers(0, S, size=H)
        allowed = (b_isl[:, None] == h_isl[None, :])

    assign, prices = bertsekas_assignment(value, allowed, eps)
    sold = assign >= 0
    matched_homes = assign[sold]
    realized_value = value[np.where(sold)[0], matched_homes]
    sale_prices = prices[matched_homes]
    # surplus accounting
    total_surplus = realized_value.sum()                          # = match value created
    seller_rev = sale_prices.sum()
    buyer_surplus = (realized_value - sale_prices).sum()
    n_sold = int(sold.sum())

    # First-best (efficient) total surplus = unconstrained optimal assignment value
    from scipy.optimize import linear_sum_assignment
    ri, cj = linear_sum_assignment(-value)                        # global optimum (board-feasible)
    k = min(B, H)
    firstbest = value[ri[:k], cj[:k]].sum()

    return dict(avg_price=float(sale_prices.mean()) if n_sold else 0.0,
                total_surplus=float(total_surplus),
                seller_rev=float(seller_rev),
                buyer_surplus=float(buyer_surplus),
                n_sold=n_sold,
                avg_match_value=float(realized_value.mean()) if n_sold else 0.0,
                efficiency=float(total_surplus / firstbest))      # share of first-best realized


def expB():
    H = 60             # fixed housing stock
    S = 6              # number of local submarkets in the segmented world
    kappa = 0.8        # weight on idiosyncratic taste (sorting gains scale with this)
    reps = 20
    thetas = [0.8, 1.0, 1.25, 1.5, 2.0]   # market tightness = buyers / homes
    rows = []
    for theta in thetas:
        B = int(round(theta * H))
        seg = [run_market(B, H, S, kappa, board=False) for _ in range(reps)]
        brd = [run_market(B, H, S, kappa, board=True) for _ in range(reps)]
        def avg(lst, k): return float(np.mean([d[k] for d in lst]))
        r = dict(theta=theta, B=B, H=H,
                 price_seg=avg(seg, "avg_price"), price_brd=avg(brd, "avg_price"),
                 surplus_seg=avg(seg, "total_surplus"), surplus_brd=avg(brd, "total_surplus"),
                 buyer_seg=avg(seg, "buyer_surplus"), buyer_brd=avg(brd, "buyer_surplus"),
                 seller_seg=avg(seg, "seller_rev"), seller_brd=avg(brd, "seller_rev"),
                 eff_seg=avg(seg, "efficiency"), eff_brd=avg(brd, "efficiency"),
                 sold_seg=avg(seg, "n_sold"), sold_brd=avg(brd, "n_sold"),
                 matchq_seg=avg(seg, "avg_match_value"), matchq_brd=avg(brd, "avg_match_value"))
        r["price_chg_pct"] = round((r["price_brd"]/r["price_seg"]-1)*100, 1)
        r["surplus_chg_pct"] = round((r["surplus_brd"]/r["surplus_seg"]-1)*100, 1)
        r["buyer_chg_pct"] = round((r["buyer_brd"]/r["buyer_seg"]-1)*100, 1) if r["buyer_seg"] else float("nan")
        r["seller_chg_pct"] = round((r["seller_brd"]/r["seller_seg"]-1)*100, 1)
        rows.append(r)
        print(f"theta={theta}: price {r['price_seg']:.2f}->{r['price_brd']:.2f} "
              f"({r['price_chg_pct']:+}%) | surplus {r['surplus_chg_pct']:+}% | "
              f"buyer {r['buyer_chg_pct']:+}% | seller {r['seller_chg_pct']:+}%")

    # ---- decomposition figure ----
    th = [r["theta"] for r in rows]
    fig, ax = plt.subplots(1, 3, figsize=(15, 4.6))

    ax[0].plot(th, [r["price_chg_pct"] for r in rows], "o-", color="firebrick")
    ax[0].axhline(0, color="k", lw=.6)
    ax[0].set_xlabel("market tightness  θ = buyers / homes")
    ax[0].set_ylabel("% change in avg transaction price\n(board vs segmented)")
    ax[0].set_title("B1. Board raises prices — more so\nwhen supply is the binding constraint")
    ax[0].grid(alpha=.3)

    width = 0.35; x = np.arange(len(th))
    ax[1].bar(x-width/2, [r["buyer_chg_pct"] for r in rows], width, label="buyer surplus", color="tab:blue")
    ax[1].bar(x+width/2, [r["seller_chg_pct"] for r in rows], width, label="seller revenue", color="tab:orange")
    ax[1].axhline(0, color="k", lw=.6)
    ax[1].set_xticks(x); ax[1].set_xticklabels(th)
    ax[1].set_xlabel("market tightness  θ"); ax[1].set_ylabel("% change (board vs segmented)")
    ax[1].set_title("B2. Who wins? Sellers gain, buyers can lose\n(surplus TRANSFER)")
    ax[1].legend(fontsize=8); ax[1].grid(alpha=.3)

    ax[2].plot(th, [r["eff_seg"]*100 for r in rows], "s--", label="segmented", color="gray")
    ax[2].plot(th, [r["eff_brd"]*100 for r in rows], "o-", label="board", color="tab:green")
    ax[2].set_xlabel("market tightness  θ"); ax[2].set_ylabel("% of first-best surplus realized")
    ax[2].set_title("B3. Board improves ALLOCATIVE efficiency\n(real value, not just transfer)")
    ax[2].legend(fontsize=8); ax[2].grid(alpha=.3)
    fig.tight_layout(); fig.savefig(FIG / "fig2_assignment_decomposition.png", dpi=130)
    plt.close(fig)
    return rows


if __name__ == "__main__":
    print("=== Experiment A: order statistics on a single scarce asset ===")
    A = expA()
    print(json.dumps(A, indent=2))
    print("\n=== Experiment B: equilibrium assignment market ===")
    B = expB()
    with open(OUT / "sim_results.json", "w") as f:
        json.dump({"experimentA": A, "experimentB": B}, f, indent=2)
    print("\nSaved figures + data/sim_results.json")
