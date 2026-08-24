# Sim Desk — Paper Trading Simulator

Training simulator for interns: $100k paper account over the ~2,470 stocks/ETFs
regime-desk publishes a theme for. Orders fill at the most recent **daily close**
from `docs/data/prices.json`, refreshed by CI each weekday after the close
(no intraday execution, no shorting, no margin, no commissions).
Account state lives in the browser's localStorage only — nothing is stored
server-side. Equity curve marks once per trading day and is compared to SPY.

Live: https://helioskozak-cloud.github.io/sim-desk/

## When the price feed is incomplete

A close the fetch could not refresh is **carried forward from the previous
snapshot and tagged in `stale` with its own date** — never dropped. The app
shows it, badged with that date, and hides the day change (its `prev` is the
day before *that* close, not yesterday). Fills against a stale close are
allowed but confirmed, and the trade log records the real date.

A position with no close anywhere falls back to cost basis, and cost basis is
**labelled as a placeholder** rather than totalled as if it were market value.
While any position is in that state the equity curve **skips the day**: a curve
point is permanent, so it only gets written when the mark behind it is complete.

This is all here because of 2026-08-20 — see the header comments in
`scan/fetch_prices.py` and `tests/check.mjs`. The universe grew past what a
single `yf.download` could carry, 1,058 tickers vanished from the published
file without a word, and two days of equity curve were written off totals that
were partly cost basis.

`coverage` in `prices.json` reports how much of the universe is genuinely
fresh, and the workflow fails the run when it falls below `FRESH_FLOOR` or when
SPY itself is stale.

## Tests

```
python -m pytest tests/test_fetch_prices.py -q     # the merge + carry-forward logic
node tests/check.mjs                               # the front end
```

`check.mjs` runs `docs/index.html`'s real page script under Node against the
committed price file — no browser, no build step, no dependencies. It extracts
the `<script>` block rather than duplicating it, so it cannot pass against a
copy of logic that never shipped.

`test_fetch_prices.py` stubs the download and the sector-map request, so it is
a statement about the merge logic and touches no network.

Both run in CI after the push — never before, because carrying a missing close
forward makes the file safe to publish however badly the fetch went. A red test
should surface the problem, not withhold the day's prices.

Every assertion in both was mutation-tested: 23 mutants planted across
`fetch_prices.py` and `index.html`, all 23 killed.
