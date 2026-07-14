"""
intern_report.py — daily supervisor report for sim-desk paper trading.

Reads the telemetry log the signal API collects (C:\\Portfolizer\\sim-logs\\
events.jsonl) plus the published price file, replays each trader's trades into
positions, and writes a markdown report to C:\\Portfolizer\\sim-reports\\.
Runs on the supervisor's machine via a daily scheduled task; nothing leaves
the box.
"""
import json
import datetime
from collections import defaultdict
from pathlib import Path

LOG = Path(r"C:\Portfolizer\sim-logs\events.jsonl")
PRICES = Path(r"C:\Portfolizer\sim-desk\docs\data\prices.json")
OUT_DIR = Path(r"C:\Portfolizer\sim-reports")
START_CASH = 100000.0


def main() -> None:
    today = datetime.date.today().isoformat()
    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f"intern-report-{today}.md"

    events = []
    if LOG.exists():
        for line in LOG.read_text(encoding="utf-8").splitlines():
            try:
                events.append(json.loads(line))
            except Exception:
                continue
    px = json.loads(PRICES.read_text(encoding="utf-8")) if PRICES.exists() else {}
    prices, names = px.get("prices", {}), px.get("names", {})

    lines = [f"# Sim Desk — supervisor report, {today}", ""]
    if not events:
        lines.append("No telemetry received yet — either no trades have been made, "
                     "or the intern's browser hasn't reached the API (events queue "
                     "client-side and flush when it's reachable).")
    by_trader = defaultdict(list)
    for e in events:
        by_trader[e.get("trader", "intern")].append(e)

    for who, evs in sorted(by_trader.items()):
        trades = [e for e in evs if e.get("type") == "trade"]
        snaps = [e for e in evs if e.get("type") == "snapshot"]
        lines += [f"## {who}", ""]

        # Replay into positions
        cash, lots = START_CASH, defaultdict(lambda: {"qty": 0.0, "cost": 0.0})
        for tr in trades:
            qty, p = float(tr.get("qty", 0)), float(tr.get("px", 0))
            t = tr.get("t", "?")
            if tr.get("side") == "BUY":
                cash -= qty * p
                lots[t]["qty"] += qty; lots[t]["cost"] += qty * p
            else:
                frac = min(qty / lots[t]["qty"], 1.0) if lots[t]["qty"] else 0
                lots[t]["cost"] *= (1 - frac); lots[t]["qty"] -= qty
                cash += qty * p
        lots = {t: v for t, v in lots.items() if v["qty"] > 1e-9}
        pos_val = sum(v["qty"] * prices.get(t, v["cost"] / max(v["qty"], 1e-9))
                      for t, v in lots.items())
        total = cash + pos_val
        pl = total - START_CASH
        spy_marks = [s for s in snaps if s.get("spy")]
        spy_line = ""
        if len(spy_marks) >= 1 and prices.get("SPY"):
            spy0 = float(spy_marks[0]["spy"])
            spy_pct = (prices["SPY"] / spy0 - 1) * 100
            alpha = pl / START_CASH * 100 - spy_pct
            spy_line = (f" · SPY same period {spy_pct:+.2f}% · "
                        f"**alpha {alpha:+.2f}pp**")
        lines.append(f"**Account:** ${total:,.0f} (cash ${cash:,.0f}) · "
                     f"P&L {pl:+,.0f} ({pl / START_CASH * 100:+.2f}%){spy_line}")
        lines.append("")

        todays = [t for t in trades if str(t.get("ts", "")).startswith(today)]
        lines.append(f"**Today's trades ({len(todays)}):**" if todays
                     else "**No trades today.**")
        for tr in todays:
            t = tr.get("t", "?")
            lines.append(f"- {tr.get('ts','')} {tr.get('side','?')} "
                         f"{float(tr.get('qty',0)):g} {t} "
                         f"({names.get(t, '')}) @ ${float(tr.get('px',0)):,.2f} "
                         f"= ${float(tr.get('value',0)):,.0f}")
        lines.append("")
        if lots:
            lines.append("**Positions:**")
            lines.append("| Ticker | Name | Qty | Avg cost | Last | Value | P&L |")
            lines.append("|---|---|---|---|---|---|---|")
            for t, v in sorted(lots.items(), key=lambda kv: -kv[1]["cost"]):
                avg = v["cost"] / v["qty"]
                last = prices.get(t)
                val = v["qty"] * (last if last else avg)
                ppl = (last - avg) * v["qty"] if last else 0.0
                lines.append(f"| {t} | {names.get(t, '—')} | {v['qty']:g} | "
                             f"${avg:,.2f} | {'$%.2f' % last if last else '—'} | "
                             f"${val:,.0f} | {ppl:+,.0f} |")
        else:
            lines.append("**No open positions.**")
        lines += ["", f"Lifetime trades: {len(trades)} · telemetry events: {len(evs)}", ""]

    lines.append(f"\n---\nGenerated {datetime.datetime.now().isoformat(timespec='minutes')} "
                 f"from {LOG} · prices as of {px.get('as_of', '—')}")
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
