"""
fetch_prices.py — daily EOD close snapshot for the sim-desk paper-trading app.

Universe = regime-desk's published sector map (~1,380 stocks and ETFs) + SPY.
Writes docs/data/prices.json: {as_of, prev_date, prices: {T: close},
prev: {T: prev close}, themes: {T: theme}}. Fills in the simulator execute at
these closes — this is an end-of-day training tool by design.
"""
import json
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).parent.parent
OUT = ROOT / "docs" / "data" / "prices.json"
SECTOR_MAP_URL = ("https://raw.githubusercontent.com/helioskozak-cloud/"
                  "regime-desk/main/data/sector_map.json")


def main() -> None:
    themes = requests.get(SECTOR_MAP_URL, timeout=30).json()
    tickers = sorted({str(t).upper() for t in themes}) + ["SPY"]
    print(f"universe: {len(tickers)} tickers", flush=True)

    px = yf.download(tickers, period="7d", interval="1d",
                     auto_adjust=True, threads=True, progress=False)["Close"]
    px = px.dropna(axis=1, how="all").ffill()
    last = px.iloc[-1]
    prev = px.iloc[-2] if len(px) > 1 else last

    out = {
        "as_of": px.index[-1].date().isoformat(),
        "prev_date": px.index[-2].date().isoformat() if len(px) > 1 else None,
        "prices": {t: round(float(v), 4) for t, v in last.items() if pd.notna(v)},
        "prev": {t: round(float(v), 4) for t, v in prev.items() if pd.notna(v)},
        "themes": {str(t).upper(): v for t, v in themes.items()},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {OUT}: {len(out['prices'])} priced tickers as of {out['as_of']}",
          flush=True)


if __name__ == "__main__":
    main()
