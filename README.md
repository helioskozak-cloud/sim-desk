# Sim Desk — Paper Trading Simulator

Training simulator for interns: $100k paper account over the ~1,380 stocks/ETFs
regime-desk tracks. Orders fill at the most recent **daily close** from
`docs/data/prices.json`, refreshed by CI each weekday after the close
(no intraday execution, no shorting, no margin, no commissions).
Account state lives in the browser's localStorage only — nothing is stored
server-side. Equity curve marks once per trading day and is compared to SPY.

Live: https://helioskozak-cloud.github.io/sim-desk/
