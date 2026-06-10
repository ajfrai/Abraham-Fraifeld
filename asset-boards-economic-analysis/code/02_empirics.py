"""
Empirical companion to the simulation. Uses real FRED series (downloaded as CSV).
Three original descriptive tests of the "asset boards made homes/jobs scarce &
expensive" hypothesis:

  Fig 3  Housing timeline: real house prices & price-to-income vs platform launches.
         Key fact -> Zillow launched Feb-2006 (the exact bubble PEAK); real prices
         then FELL ~27% over 6 yrs while Zillow adoption exploded. The platform
         timing does NOT line up with a structural price break.

  Fig 4  The recent "scarcity" is an INVENTORY (supply) story, a decade after the
         platforms matured: active listings collapsed and days-on-market fell.

  Fig 5  Labor: the Beveridge curve (job-openings rate vs unemployment) and real
         median wages — testing for a matching breakdown / wage suppression in the
         online-job-board era.
"""
import numpy as np, pandas as pd, json
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "data"
FIG = Path(__file__).resolve().parent.parent / "figures"

def load(name, col=None):
    df = pd.read_csv(D / f"{name}.csv", parse_dates=["observation_date"])
    df = df.rename(columns={"observation_date": "date", name: col or name})
    df[col or name] = pd.to_numeric(df[col or name], errors="coerce")
    return df.dropna()

cpi   = load("CPIAUCSL", "cpi")
csi   = load("CSUSHPISA", "hpi")          # Case-Shiller national, SA
mspus = load("MSPUS", "price")            # median sale price, nominal
inc   = load("MEHOINUSA672N", "rinc")     # real median household income (2024$)
mos   = load("MSACSR", "months")          # months' supply of new homes
listg = load("ACTLISCOUUS", "active")     # active listings (Realtor.com), 2016+
dom   = load("MEDDAYONMARUS", "dom")      # median days on market, 2016+
jor   = load("JTSJOR", "openings")        # job openings rate
unr   = load("UNRATE", "u")               # unemployment rate
wage  = load("LES1252881600Q", "rwage")   # real median weekly earnings (1982-84$)

PLATFORMS = [(1996, "Realtor.com"), (2003, "LinkedIn"),
             (2004, "Indeed"), (2006, "Zillow / Redfin")]

cpi_2024 = cpi.set_index("date")["cpi"].resample("YS").mean().loc["2024"].mean()

# ---------- FIG 3: housing timeline ----------
h = csi.copy()
h = h.merge(cpi, on="date", how="left")
h["real_hpi"] = h["hpi"] / h["cpi"] * cpi_2024     # real, 2024 dollars index units
h["real_hpi"] = h["real_hpi"] / h.loc[h["date"]=="2000-01-01","real_hpi"].values[0] * 100

# price-to-income (real): deflate median price to 2024$, divide by real income
m = mspus.copy().merge(cpi, on="date", how="left")
m["real_price"] = m["price"] / m["cpi"] * cpi_2024
m["year"] = m["date"].dt.year
m_ann = m.groupby("year")["real_price"].mean().reset_index()
pti = m_ann.merge(inc.assign(year=inc["date"].dt.year)[["year","rinc"]], on="year", how="inner")
pti["ratio"] = pti["real_price"] / pti["rinc"]

fig, ax = plt.subplots(1, 2, figsize=(13.5, 4.8))
ax[0].plot(h["date"], h["real_hpi"], color="navy", lw=1.6)
ax[0].set_title("3A. Real U.S. house prices (2024$, index 2000=100)")
ax[0].set_ylabel("real Case-Shiller, 2000=100")
for yr, name in PLATFORMS:
    ax[0].axvline(pd.Timestamp(f"{yr}-01-01"), color="gray", ls="--", lw=.8)
    ax[0].text(pd.Timestamp(f"{yr}-06-01"), ax[0].get_ylim()[1]*0.96, name,
               rotation=90, va="top", fontsize=7, color="dimgray")
ax[0].annotate("Zillow launches at the\nEXACT price peak (2006)…",
               xy=(pd.Timestamp("2006-06-01"), 168), xytext=(pd.Timestamp("2008-06-01"), 185),
               fontsize=8, color="firebrick",
               arrowprops=dict(arrowstyle="->", color="firebrick"))
ax[0].annotate("…then real prices fall ~27%\nas adoption explodes",
               xy=(pd.Timestamp("2012-01-01"), 120), xytext=(pd.Timestamp("2012-06-01"), 150),
               fontsize=8, color="firebrick")
ax[0].grid(alpha=.3)

ax[1].plot(pti["year"], pti["ratio"], "o-", color="darkgreen", ms=3)
ax[1].set_title("3B. Real median house price / real median income")
ax[1].set_ylabel("years of median income per median home")
for yr, name in PLATFORMS:
    ax[1].axvline(yr, color="gray", ls="--", lw=.8)
ax[1].grid(alpha=.3)
fig.tight_layout(); fig.savefig(FIG / "fig3_housing_timeline.png", dpi=130); plt.close(fig)

# ---------- FIG 4: inventory / scarcity is a supply story (2016+) ----------
fig, ax = plt.subplots(1, 2, figsize=(13.5, 4.4))
ax[0].plot(listg["date"], listg["active"]/1e6, color="teal", lw=1.6)
ax[0].set_title("4A. Active for-sale listings collapsed (2016–present)")
ax[0].set_ylabel("active listings (millions)")
ax[0].axvspan(pd.Timestamp("2020-03-01"), pd.Timestamp("2022-06-01"),
              color="orange", alpha=.12)
ax[0].text(pd.Timestamp("2020-06-01"), listg["active"].max()/1e6*0.5,
           "COVID demand shock\n+ rate-lock supply freeze", fontsize=7, color="darkorange")
ax[0].grid(alpha=.3)
ax2 = ax[0].twinx()
ax2.plot(mos[mos["date"]>="2016-01-01"]["date"],
         mos[mos["date"]>="2016-01-01"]["months"], color="brown", lw=1, alpha=.6)
ax2.set_ylabel("months' supply (new homes)", color="brown")

ax[1].plot(dom["date"], dom["dom"], color="purple", lw=1.6)
ax[1].set_title("4B. Median days-on-market: homes sell faster (scarcer at price)")
ax[1].set_ylabel("median days on market")
ax[1].grid(alpha=.3)
fig.tight_layout(); fig.savefig(FIG / "fig4_inventory.png", dpi=130); plt.close(fig)

# ---------- FIG 5: labor — Beveridge curve + real wages ----------
bev = jor.merge(unr, on="date", how="inner").dropna()
def era(d):
    if d < pd.Timestamp("2009-07-01"): return ("2000–2009", "tab:blue")
    if d < pd.Timestamp("2020-03-01"): return ("2009–2020", "tab:orange")
    return ("2020–present", "tab:red")
bev["era"], bev["c"] = zip(*bev["date"].map(lambda d: era(d)))

fig, ax = plt.subplots(1, 2, figsize=(13.5, 4.8))
for e in ["2000–2009", "2009–2020", "2020–present"]:
    s = bev[bev["era"] == e]
    ax[0].scatter(s["u"], s["openings"], s=12, label=e, alpha=.7)
ax[0].set_xlabel("unemployment rate (%)"); ax[0].set_ylabel("job-openings rate (%)")
ax[0].set_title("5A. Beveridge curve: did online boards break matching?")
ax[0].legend(fontsize=8, title="period"); ax[0].grid(alpha=.3)

w = wage.merge(cpi, on="date", how="left")
ax[1].plot(wage["date"], wage["rwage"], color="darkred", lw=1.6)
ax[1].set_title("5B. Real median weekly earnings (1982–84$)")
ax[1].set_ylabel("constant-$ weekly earnings")
for yr, name in [(2003,"LinkedIn"),(2004,"Indeed")]:
    ax[1].axvline(pd.Timestamp(f"{yr}-01-01"), color="gray", ls="--", lw=.8)
    ax[1].text(pd.Timestamp(f"{yr}-06-01"), wage["rwage"].min()*1.01, name,
               rotation=90, fontsize=7, color="dimgray")
ax[1].grid(alpha=.3)
fig.tight_layout(); fig.savefig(FIG / "fig5_labor.png", dpi=130); plt.close(fig)

# ---------- key numbers ----------
peak06 = h[(h["date"]>="2006-01-01")&(h["date"]<="2006-12-01")]["real_hpi"].max()
trough = h[(h["date"]>="2011-01-01")&(h["date"]<="2012-12-01")]["real_hpi"].min()
latest_hpi = h.iloc[-1]
stats = {
  "real_house_price_2000_to_latest_pct": round(float(latest_hpi["real_hpi"]-100),1),
  "real_price_peak2006_index": round(float(peak06),1),
  "real_price_trough2011_12_index": round(float(trough),1),
  "peak_to_trough_drop_pct": round(float((trough/peak06-1)*100),1),
  "pti_2000": round(float(pti[pti.year==2000]["ratio"].values[0]),2),
  "pti_2006": round(float(pti[pti.year==2006]["ratio"].values[0]),2),
  "pti_latest": round(float(pti.iloc[-1]["ratio"]),2),
  "active_listings_2016_07": int(listg.iloc[0]["active"]),
  "active_listings_latest": int(listg.iloc[-1]["active"]),
  "listings_drop_pct": round(float((listg.iloc[-1]["active"]/listg.iloc[0]["active"]-1)*100),1),
  "real_wage_2003": float(wage[wage.date>="2003-01-01"].iloc[0]["rwage"]),
  "real_wage_latest": float(wage.iloc[-1]["rwage"]),
  "real_wage_chg_pct_since2003": round(float((wage.iloc[-1]["rwage"]/wage[wage.date>="2003-01-01"].iloc[0]["rwage"]-1)*100),1),
}
print(json.dumps(stats, indent=2))
with open(D/"empirical_stats.json","w") as f: json.dump(stats, f, indent=2)
print("Saved figs 3-5 and data/empirical_stats.json")
