"""
fetch_prices.py — daily EOD close snapshot for the sim-desk paper-trading app.

Universe = regime-desk's published sector map (~2,470 stocks and ETFs) + SPY.
Writes docs/data/prices.json: {as_of, prev_date, prices: {T: close},
prev: {T: prev close}, stale: {T: that ticker's own close date}, themes, names,
coverage}. Fills in the simulator execute at these closes — this is an
end-of-day training tool by design.

WHAT WENT WRONG ON 2026-08-20, AND WHAT THIS FILE NOW DOES ABOUT IT
-------------------------------------------------------------------
regime-desk's universe refresh took the sector map from 1,380 tickers to 2,471
on 2026-08-18. This script asked Yahoo for all of them in ONE `yf.download`
call and then ran `dropna(axis=1, how="all")`, which silently deletes every
ticker that came back empty. Yahoo could not serve a request that size:

    08-18   2,468 of 2,470 priced
    08-19   2,236
    08-20   1,388      <- 1,082 tickers vanished from the file
    08-21   1,410

MSFT, AMZN, TSLA, BRK-B, JPM, V, LLY and AVGO were among the missing. The app
falls back to cost basis for any position it cannot price, so a chunk of every
intern's book silently re-marked to cost and that number went into the
permanent equity curve. A feed gap became corrupted history.

Three changes, in order of importance:

1. **A ticker is never dropped for being absent.** The previous snapshot is
   already committed in this repo, so a close that did not arrive is carried
   forward and tagged in `stale` with the date it actually belongs to. The
   file can now only ever improve on the day before. This is the structural
   fix: silence was the bug, not the rate limit.

2. **Chunked download with retries**, so 2,470 tickers actually fit through an
   endpoint that will not serve them in one request.

3. **Coverage is published, not implied.** `coverage` states how much of the
   universe is genuinely fresh, and the workflow fails the run when that falls
   through the floor. The old file's ticker count WAS the coverage signal, and
   nothing was reading it.

Per-ticker dates rather than one global date, because "stale" is a property of
a ticker (halted, delisted, missed by a chunk), not of the run.
"""
import json
import time
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).parent.parent
OUT = ROOT / "docs" / "data" / "prices.json"
SECTOR_MAP_URL = ("https://raw.githubusercontent.com/helioskozak-cloud/"
                  "regime-desk/main/data/sector_map.json")

# Yahoo will not serve the whole universe in one request. 200 is comfortably
# under where the truncation started and keeps the run to ~13 requests.
CHUNK = 200
RETRIES = 3
RETRY_SLEEP = 5

# Below this share of the universe priced from a FRESH close, the run is
# reported as failed even though the file it wrote is still usable — see the
# workflow's coverage gate. 08-18 managed 99.9%; the broken runs sat near 57%.
FRESH_FLOOR = 0.90


def load_previous() -> dict:
    """The last published snapshot. It is committed in this repo, which is why
    carrying a missing close forward costs nothing and needs no external
    store."""
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def load_existing_names(prev: dict) -> dict:
    """Company names carry over run to run and grow incrementally — the name
    endpoint is rate-limited, so we never re-fetch what we already have."""
    names = dict(prev.get("names", {}))
    # Local seed: the finvisible fundamentals cache, when present on this box.
    seed = Path(r"C:\Portfolizer\finvisible\data\cache\fundamentals.json")
    if seed.exists():
        try:
            rows = json.loads(seed.read_text(encoding="utf-8")).get("rows", {})
            for t, v in rows.items():
                if v.get("name") and t not in names:
                    names[t] = v["name"]
        except Exception:
            pass
    return names


def extend_names(names: dict, tickers: list[str], cap: int = 150) -> dict:
    """Fill up to `cap` missing names per run via yfinance (tolerates the
    endpoint being rate-limited — partial progress each run is the design)."""
    missing = [t for t in tickers if t not in names and t != "SPY"]
    deadline = time.monotonic() + 240
    got = 0
    for t in missing[:cap]:
        if time.monotonic() > deadline:
            break
        try:
            n = yf.Ticker(t).info.get("shortName")
            if n:
                names[t] = n
                got += 1
        except Exception:
            break  # rate-limited — stop burning the cap this run
    print(f"names: +{got} this run, {len(names)} total", flush=True)
    return names


def _closes_frame(batch: list[str]) -> pd.DataFrame | None:
    """One chunk's Close frame, or None if the request gave us nothing.

    yfinance hands back a plain Series for a single ticker and a MultiIndexed
    frame for several, so both shapes are normalised to columns=tickers here
    rather than at every call site."""
    raw = yf.download(batch, period="7d", interval="1d", auto_adjust=True,
                      threads=True, progress=False)
    if raw is None or raw.empty:
        return None
    close = raw["Close"] if "Close" in raw else raw
    if isinstance(close, pd.Series):
        close = close.to_frame(name=batch[0])
    return close if not close.empty else None


def _drop_open_session() -> pd.Timestamp | None:
    """The date to exclude because its session has not finished yet, or None.

    Mid-session, yfinance dates the current quote today and it looks exactly
    like a close. The app fills orders at "the most recent daily close" and
    prints that date on every trade, so publishing a live quote under it would
    make the fill basis a lie — the same placeholder-as-fact shape this file's
    header is about.

    21:00 UTC is 16:00 ET under EST and 17:00 ET under EDT, so the test holds
    year-round without needing a tz database on the runner. The 21:43 cron
    clears it in both."""
    now = pd.Timestamp.now(tz="UTC")
    return None if now.hour >= 21 else now.normalize().tz_localize(None)


def fetch_closes(tickers: list[str]) -> dict[str, tuple[pd.Timestamp, float, float, pd.Timestamp]]:
    """{ticker: (its own last close DATE, last close, prior close, prior DATE)}.

    Downloaded in chunks with retries. A chunk that will not come back after
    RETRIES attempts leaves its tickers absent from the result — the caller
    carries those forward rather than deleting them.

    The date is per ticker, taken from that column's own last non-null entry,
    so a name that stopped trading on Tuesday is dated Tuesday instead of
    inheriting the run's date and looking current."""
    out: dict[str, tuple[pd.Timestamp, float, float, pd.Timestamp]] = {}
    open_session = _drop_open_session()
    if open_session is not None:
        print(f"session still open — excluding {open_session.date()} rows; the "
              f"most recent COMPLETED close is what fills at", flush=True)
    batches = [tickers[i:i + CHUNK] for i in range(0, len(tickers), CHUNK)]
    for n, batch in enumerate(batches, 1):
        close = None
        for attempt in range(1, RETRIES + 1):
            try:
                close = _closes_frame(batch)
                if close is not None:
                    break
                print(f"  chunk {n}/{len(batches)}: empty (attempt {attempt})", flush=True)
            except Exception as exc:
                print(f"  chunk {n}/{len(batches)}: {type(exc).__name__} {exc} "
                      f"(attempt {attempt})", flush=True)
            if attempt < RETRIES:
                time.sleep(RETRY_SLEEP)
        if close is None:
            print(f"  chunk {n}/{len(batches)}: GAVE UP on {len(batch)} tickers — "
                  f"carrying their previous closes forward", flush=True)
            continue
        got = 0
        for col in close.columns:
            s = pd.to_numeric(close[col], errors="coerce").dropna()
            if open_session is not None:
                s = s[s.index.normalize() < open_session]
            if s.empty:
                continue
            last = float(s.iloc[-1])
            prior = float(s.iloc[-2]) if len(s) > 1 else last
            prior_d = s.index[-2] if len(s) > 1 else s.index[-1]
            out[str(col).upper()] = (s.index[-1], last, prior, prior_d)
            got += 1
        print(f"  chunk {n}/{len(batches)}: {got}/{len(batch)} priced", flush=True)
    return out


def main() -> None:
    themes = requests.get(SECTOR_MAP_URL, timeout=30).json()
    tickers = sorted({str(t).upper() for t in themes} | {"SPY"})
    print(f"universe: {len(tickers)} tickers", flush=True)

    prev_file = load_previous()
    fresh = fetch_closes(tickers)
    print(f"fresh closes: {len(fresh)}/{len(tickers)}", flush=True)

    # The run's date is the newest close anyone reported. A ticker whose own
    # last close predates it is stale — whether it was missed by a chunk, has
    # been halted, or was carried over from the previous file.
    dates = sorted({d.normalize() for d, _, _, _ in fresh.values()})
    as_of = dates[-1] if dates else None
    # The session before as_of, taken from the PRIOR dates of the tickers that
    # actually traded on as_of. Not `dates[-2]`: that is the second-newest LAST
    # date across the universe, so one halted name dated 08-20 would report
    # 08-20 as the previous session when it was 08-21.
    prior_dates = sorted({pd_.normalize() for d, _, _, pd_ in fresh.values()
                          if d.normalize() == as_of and pd_.normalize() < as_of})
    prev_date = prior_dates[-1] if prior_dates else None

    old_prices = prev_file.get("prices", {})
    old_prev = prev_file.get("prev", {})
    old_stale = prev_file.get("stale", {})
    old_as_of = prev_file.get("as_of")

    if as_of is None:
        # The whole download failed. Republishing the previous file unchanged
        # is strictly better than writing an empty one, which would unprice
        # every position in every intern's book at once.
        if not old_prices:
            raise SystemExit("no closes fetched and no previous file to fall back on")
        print("NO closes fetched at all — republishing the previous snapshot "
              "unchanged", flush=True)
        as_of_str = old_as_of
        # Republished verbatim, per-ticker staleness included. Not blanket-marked
        # stale: every price here is still from the date in the header, which is
        # what `stale` means. That the RUN failed is `coverage.fresh == 0`, and
        # the workflow gate fails on it.
        prices, prev, stale = dict(old_prices), dict(old_prev), dict(old_stale)
        fresh_n = 0
    else:
        as_of_str = as_of.date().isoformat()
        prices, prev, stale = {}, {}, {}
        fresh_n = 0
        for t in tickers:
            if t in fresh:
                d, last, prior, _ = fresh[t]
                prices[t] = round(last, 4)
                prev[t] = round(prior, 4)
                if d.normalize() < as_of:
                    # Priced, but not as of today — a halt, a delisting, or a
                    # short history. Dated honestly rather than presented as
                    # today's close.
                    stale[t] = d.date().isoformat()
                else:
                    fresh_n += 1
            elif t in old_prices:
                # Carried forward. THE POINT OF THIS WHOLE FILE: the position
                # keeps a real price instead of disappearing and being re-marked
                # at cost by the front end.
                prices[t] = old_prices[t]
                if t in old_prev:
                    prev[t] = old_prev[t]
                stale[t] = old_stale.get(t) or old_as_of or "unknown"

    # A carried-forward close dated the same day as this run is not stale — the
    # previous file already held that session's close and we simply failed to
    # re-fetch it. Flagging it anyway would put a stale marker on a price whose
    # own date matches the header, which reads as a bug and blunts the marker
    # where it does mean something.
    stale = {t: d for t, d in stale.items() if d != as_of_str}

    carried = len(stale)
    coverage = {
        "universe": len(tickers),
        "priced": len(prices),
        "fresh": fresh_n,
        "stale": carried,
        "fresh_pct": round(fresh_n / len(tickers), 4) if tickers else 0.0,
        "floor": FRESH_FLOOR,
        "spy_fresh": "SPY" in prices and "SPY" not in stale,
    }

    names = extend_names(load_existing_names(prev_file), tickers)

    out = {
        "as_of": as_of_str,
        "prev_date": prev_date.date().isoformat() if prev_date is not None
                     else prev_file.get("prev_date"),
        "prices": prices,
        "prev": prev,
        # {ticker: the date ITS close is from} — present only for tickers whose
        # price is older than as_of. The front end shows these marked and
        # refuses to write an equity-curve point off them.
        "stale": stale,
        "themes": {str(t).upper(): v for t, v in themes.items()},
        "names": names,
        "coverage": coverage,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {OUT}: {len(prices)} priced ({fresh_n} fresh, {carried} stale) "
          f"as of {as_of_str}", flush=True)
    if coverage["fresh_pct"] < FRESH_FLOOR:
        print(f"::warning::fresh coverage {coverage['fresh_pct']:.1%} is below the "
              f"{FRESH_FLOOR:.0%} floor — {carried} tickers are carrying an older "
              f"close", flush=True)


if __name__ == "__main__":
    main()
