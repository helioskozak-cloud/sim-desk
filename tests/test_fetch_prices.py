"""What the price fetch does with an incomplete download.

THE BUG THESE DEFEND AGAINST

The universe grew from 1,380 tickers to 2,471 on 2026-08-18. The fetch asked
Yahoo for all of them in one request, Yahoo would not serve it, and
`dropna(axis=1, how="all")` deleted every ticker that came back empty — 1,058
of them by 08-20, MSFT and BRK-B included. Nothing said a word; the file just
got smaller. Downstream, sim-desk re-marked those positions at cost basis and
wrote the result into a permanent equity curve.

The rule now is that a ticker is never dropped for being absent. What these
pin is that the carry-forward is honest: the price is the one that really was
published, tagged with the date it really belongs to, and `coverage` reports
how much of the file is genuinely fresh so the CI gate can fail on it.

Run: python -m pytest tests/test_fetch_prices.py   (or: python tests/test_fetch_prices.py)

No network — `fetch_closes` and the sector-map request are both stubbed, so
these are a statement about the merge logic and nothing else.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scan import fetch_prices as fp  # noqa: E402


D = lambda s: pd.Timestamp(s)  # noqa: E731

MAP = {"AAA": "tech", "BBB": "energy", "HALT": "tech", "SPY": "index"}


@pytest.fixture
def rig(tmp_path, monkeypatch):
    """Redirect the output file and stub everything that touches the network."""
    out = tmp_path / "prices.json"
    monkeypatch.setattr(fp, "OUT", out)
    monkeypatch.setattr(fp, "extend_names", lambda names, tickers, cap=150: names)
    monkeypatch.setattr(fp.requests, "get",
                        lambda *a, **k: type("R", (), {"json": lambda self: MAP})())

    def go(fresh, previous=None):
        if previous is not None:
            out.write_text(json.dumps(previous), encoding="utf-8")
        monkeypatch.setattr(fp, "fetch_closes", lambda tickers: fresh)
        fp.main()
        return json.loads(out.read_text(encoding="utf-8"))
    return go


def close(last_d, last, prior, prior_d):
    return (D(last_d), last, prior, D(prior_d))


ALL_FRESH = {
    "AAA":  close("2026-08-24", 10.0, 9.0, "2026-08-21"),
    "BBB":  close("2026-08-24", 20.0, 21.0, "2026-08-21"),
    "HALT": close("2026-08-24", 5.0, 5.0, "2026-08-21"),
    "SPY":  close("2026-08-24", 700.0, 690.0, "2026-08-21"),
}


# ── The carry-forward, which is the whole point ─────────────────────────────

def test_a_ticker_missing_from_the_download_keeps_its_last_price(rig):
    """The 08-20 failure, in miniature. BBB does not come back. It must not
    vanish from the file — that is what made a book re-mark to cost."""
    fresh = {k: v for k, v in ALL_FRESH.items() if k != "BBB"}
    prev = {"as_of": "2026-08-21", "prices": {"BBB": 21.0}, "prev": {"BBB": 22.0},
            "stale": {}, "names": {}}
    out = rig(fresh, prev)
    assert out["prices"]["BBB"] == 21.0
    assert out["stale"]["BBB"] == "2026-08-21", "tagged with the date it belongs to"
    assert out["coverage"]["fresh"] == 3
    assert out["coverage"]["stale"] == 1


def test_a_missing_ticker_with_no_history_is_simply_absent(rig):
    """Nothing to carry forward, so nothing is invented."""
    fresh = {k: v for k, v in ALL_FRESH.items() if k != "BBB"}
    out = rig(fresh, {"as_of": "2026-08-21", "prices": {}, "prev": {}, "stale": {}})
    assert "BBB" not in out["prices"]
    assert "BBB" not in out["stale"]


def test_a_carried_price_keeps_its_ORIGINAL_date_across_runs(rig):
    """Carried twice, it is still dated to when it was actually struck — not
    re-dated to each run that failed to refresh it. Otherwise a price drifts
    forward one day at a time and never looks stale."""
    fresh = {k: v for k, v in ALL_FRESH.items() if k != "BBB"}
    prev = {"as_of": "2026-08-21", "prices": {"BBB": 21.0}, "prev": {},
            "stale": {"BBB": "2026-08-12"}, "names": {}}
    out = rig(fresh, prev)
    assert out["stale"]["BBB"] == "2026-08-12"


# ── Dates ───────────────────────────────────────────────────────────────────

def test_a_halted_name_is_dated_to_its_own_last_close(rig):
    fresh = dict(ALL_FRESH)
    fresh["HALT"] = close("2026-08-20", 5.0, 5.1, "2026-08-19")
    out = rig(fresh)
    assert out["as_of"] == "2026-08-24"
    assert out["stale"]["HALT"] == "2026-08-20"
    assert "AAA" not in out["stale"]


def test_one_halted_name_does_not_drag_prev_date_backwards(rig):
    """`dates[-2]` would report 2026-08-20 here — the second-newest LAST date
    across the universe — when the previous SESSION was 08-21."""
    fresh = dict(ALL_FRESH)
    fresh["HALT"] = close("2026-08-20", 5.0, 5.1, "2026-08-19")
    assert rig(fresh)["prev_date"] == "2026-08-21"


def test_prev_date_is_the_session_before_as_of(rig):
    assert rig(dict(ALL_FRESH))["prev_date"] == "2026-08-21"


def test_a_carried_price_dated_the_same_day_as_the_run_is_not_flagged(rig):
    """A re-run on the same session carries prices that ARE from that session.
    Flagging them would put a stale badge on a price whose date matches the
    header, which blunts the badge where it means something."""
    fresh = {k: v for k, v in ALL_FRESH.items()
             if k != "BBB" and k != "HALT"}
    fresh = {k: close("2026-08-21", v[1], v[2], "2026-08-20") for k, v in fresh.items()}
    prev = {"as_of": "2026-08-21", "prices": {"BBB": 21.0}, "prev": {}, "stale": {}}
    out = rig(fresh, prev)
    assert out["as_of"] == "2026-08-21"
    assert "BBB" not in out["stale"], out["stale"]
    assert out["prices"]["BBB"] == 21.0


# ── Total failure ───────────────────────────────────────────────────────────

def test_a_completely_failed_download_republishes_rather_than_emptying(rig):
    """Writing an empty file would unprice every position in every book at
    once — strictly worse than yesterday's data."""
    prev = {"as_of": "2026-08-21", "prices": {"AAA": 10.0, "SPY": 700.0},
            "prev": {"AAA": 9.0}, "stale": {"AAA": "2026-08-12"}, "names": {}}
    out = rig({}, prev)
    assert out["as_of"] == "2026-08-21"
    assert out["prices"] == {"AAA": 10.0, "SPY": 700.0}
    assert out["stale"] == {"AAA": "2026-08-12"}, "not blanket-marked"
    assert out["coverage"]["fresh"] == 0, "the gate fails the run on this"


def test_a_failed_download_with_no_history_refuses_loudly(rig):
    with pytest.raises(SystemExit):
        rig({}, {"as_of": None, "prices": {}, "prev": {}, "stale": {}})


# ── Coverage, which is what CI reads ────────────────────────────────────────

def test_coverage_counts_only_genuinely_fresh_tickers(rig):
    fresh = {k: v for k, v in ALL_FRESH.items() if k != "BBB"}
    fresh["HALT"] = close("2026-08-20", 5.0, 5.1, "2026-08-19")
    prev = {"as_of": "2026-08-21", "prices": {"BBB": 21.0}, "prev": {}, "stale": {}}
    c = rig(fresh, prev)["coverage"]
    assert c["universe"] == 4
    assert c["priced"] == 4          # nothing dropped
    assert c["fresh"] == 2           # AAA and SPY only
    assert c["stale"] == 2           # BBB carried, HALT halted
    assert c["fresh_pct"] == 0.5
    assert c["spy_fresh"] is True


def test_coverage_reports_a_stale_spy(rig):
    """SPY is the benchmark leg of every intern's vs-SPY number, so it gets its
    own flag rather than hiding inside a percentage."""
    fresh = dict(ALL_FRESH)
    fresh["SPY"] = close("2026-08-20", 700.0, 690.0, "2026-08-19")
    assert rig(fresh)["coverage"]["spy_fresh"] is False


# ── The open-session guard ──────────────────────────────────────────────────

@pytest.mark.parametrize("utc_hour, drops", [(13, True), (20, True), (21, False), (23, False)])
def test_todays_partial_bar_is_excluded_until_the_close(monkeypatch, utc_hour, drops):
    """Mid-session, yfinance dates the live quote today and it is
    indistinguishable from a close. The app prints that date as the fill basis
    on every trade. 21:00 UTC clears 16:00 ET under EST and 17:00 ET under EDT,
    so the 21:43 cron passes in both."""
    fixed = pd.Timestamp(f"2026-08-24T{utc_hour:02d}:30:00", tz="UTC")
    monkeypatch.setattr(fp.pd.Timestamp, "now", classmethod(lambda cls, tz=None: fixed))
    assert (fp._drop_open_session() is not None) is drops


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
