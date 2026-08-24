// What the front end must do when the price feed is incomplete.
//
// THE BUG THESE DEFEND AGAINST
// regime-desk's universe refresh took the sector map from 1,380 tickers to
// 2,471 on 2026-08-18. scan/fetch_prices.py asked Yahoo for all of them in one
// request, Yahoo could not serve it, and `dropna(axis=1, how="all")` silently
// deleted every ticker that came back empty. By 08-20 the published file was
// missing 1,058 tickers including MSFT, AMZN, TSLA and BRK-B.
//
// totals() fell back to a position's COST when it could not price it. So a
// third of every intern's book quietly re-marked to cost basis, the account
// value fell by exactly the gain that had been erased — it looked like the
// portfolio had been liquidated — and markCurve() wrote that total into the
// equity curve, which is permanent. A feed gap became corrupted history.
//
// Run: node tests/check.mjs
//
// Every assertion here was mutation-tested. Eleven mutants were planted in
// index.html (the curve guard removed, staleAt neutered, the fill date
// falsified, the cost badge dropped, …) and all eleven fail this file.
import { run, PRICES } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  -- " + extra : ""));
  if (!cond) fails++;
};

// ---------------------------------------------------------------- fixtures
//
// THE PRICES ARE INJECTED, NOT READ OFF TODAY'S FILE.
//
// The first version of this file hardcoded MSFT at 483.24 — a Friday close —
// and went red on the very next scheduled run, because the price file it
// asserts against is rewritten every weekday by design. A test that fails
// nightly for a non-reason is worse than no test: it teaches you to ignore a
// red run, which is precisely the habit that let the 08-20 outage ship green
// twice.
//
// So each test states the payload it is about. The run still STARTS from the
// real committed prices.json, so a payload the front end cannot read still
// fails CI (see "published file contract" at the bottom) — but the numbers
// under test are ours and do not move.
const T_FRESH = "ZZTESTFRESH";   // priced, dated as_of
const T_STALE = "ZZTESTSTALE";   // priced, but from an earlier close
const T_NONE  = "ZZTESTNOMARK";  // in the universe, no price anywhere
const P_FRESH = 400, P_FRESH_PREV = 380, P_STALE = 50, STALE_DATE = "2026-01-02";

// Inject the three states into whatever the real file happens to contain.
const patch = p => {
  p.themes[T_FRESH] = "Technology";
  p.themes[T_STALE] = "Financials";
  p.themes[T_NONE]  = "Communication Services";
  p.prices[T_FRESH] = P_FRESH; p.prev[T_FRESH] = P_FRESH_PREV;
  p.prices[T_STALE] = P_STALE; p.prev[T_STALE] = P_STALE;
  p.stale = { ...(p.stale || {}), [T_STALE]: STALE_DATE };
  delete p.prices[T_NONE];            // present in the universe, absent from prices
  p.prices.SPY = 700; delete p.stale.SPY;
};
const go = (book, extra = {}) => run(book, { patch, ...extra });

const book = (lots) => ({
  cash: 10000, lots, trades: [], curve: [], spy0: null, created: "2026-08-01",
});

const FRESH  = { [T_FRESH]: { qty: 100, cost: 40000 } };
const STALE  = { [T_FRESH]: { qty: 100, cost: 40000 }, [T_STALE]: { qty: 200, cost: 14000 } };
const NOMARK = { [T_FRESH]: { qty: 100, cost: 40000 }, [T_NONE]:  { qty: 300, cost: 30000 } };

// ---------------------------------------------------------------- fresh book
{
  const { api, els } = go(book(FRESH));
  await sleep(60);
  const t = api.totals();
  ok("fresh: nothing flagged", t.unpriced === 0 && t.staleMV === 0);
  ok("fresh: MV is qty x close",
     Math.abs(t.pos - 100 * P_FRESH) < 0.01, `pos=${t.pos}`);
  ok("fresh: a curve point IS written", api.state.curve.length === 1,
     JSON.stringify(api.state.curve));
  ok("fresh: no notice banner", !els.positions.innerHTML.includes("notice"));
  ok("fresh: vs-SPY tile is live", !els.tiles.innerHTML.includes("needs every position priced"));
}

// ------------------------------------------------------- carried-forward name
{
  const { api, els } = go(book(STALE));
  await sleep(60);
  const t = api.totals();
  ok("stale: staleAt returns the ticker's own date", api.staleAt(T_STALE) === STALE_DATE);
  ok("stale: priced at the REAL close, not cost",
     Math.abs(t.pos - (100 * P_FRESH + 200 * P_STALE)) < 0.01, `pos=${t.pos}`);
  ok("stale: not counted as unpriced", t.unpriced === 0);
  ok("stale: staleMV reported", Math.abs(t.staleMV - 200 * P_STALE) < 0.01);
  ok("stale: a curve point IS still written", api.state.curve.length === 1,
     "a real older close is a usable mark");
  const h = els.positions.innerHTML;
  ok("stale: row badged with its date", h.includes("badge stale") && h.includes(STALE_DATE));
  ok("stale: notice shown", h.includes("earlier close"));
  // Column 6 is Day. A carried-forward row's `prev` is the day before ITS OWN
  // close, so the number is arithmetically fine but sits in a column every
  // other row reads as today.
  const cell = (rowHtml, n) => rowHtml.split(/<td[^>]*>/)[n].split("</td>")[0];
  const staleRow = h.split("<tr ").find(r => r.startsWith('class="stale"'));
  const freshRow = h.split("<tr ").find(r => r.startsWith('class=""'));
  ok("stale: day change suppressed on that row", cell(staleRow, 6).trim() === "—",
     `Day cell = ${cell(staleRow, 6)}`);
  ok("stale: day change still shown on the FRESH row", /%/.test(cell(freshRow, 6)),
     `mutation guard -- ${cell(freshRow, 6)}`);
  ok("stale: last close still shown", cell(staleRow, 5).includes("$" + P_STALE.toFixed(2)));
  ok("stale: P&L computed off the real close, not zeroed",
     cell(staleRow, 8).includes("$") && !cell(staleRow, 8).includes("+$0<"));
  // A missing number is not a loss. Both of these fell through to .neg and
  // painted an em dash red.
  ok("stale: the suppressed day change is dim, not red",
     /class="dim"/.test(staleRow.split("<td")[6]), staleRow.split("<td")[6]);
}

// ------------------------------------------------------------- no mark at all
{
  const { api, els } = go(book(NOMARK));
  await sleep(60);
  const t = api.totals();
  ok("nomark: counted", t.unpriced === 1);
  ok("nomark: falls back to cost", Math.abs(t.pos - (100 * P_FRESH + 30000)) < 0.01);
  ok("nomark: NO curve point written", api.state.curve.length === 0,
     "this is the 08-20 regression -- a total that is partly cost basis must not persist");
  ok("nomark: the skip is recorded", api.state.curveSkipped === api.PX.as_of);
  const h = els.positions.innerHTML;
  ok("nomark: row flagged", h.includes("badge nomark") && h.includes("no mark"));
  ok("nomark: value labelled as cost", h.includes(">cost<"));
  const nmRow = h.split("<tr ").find(r => r.startsWith('class="nomark"'));
  ok("nomark: the empty P&L is dim, not red",
     /class="dim"/.test(nmRow.split("<td")[8]), nmRow.split("<td")[8]);
  ok("nomark: red is still used where there IS a loss",
     /class="neg"/.test(h) || !/-\$/.test(h),
     "mutation guard -- dim must not have swallowed the loss colour");
  ok("nomark: notice is the hard one", h.includes("notice bad") && h.includes("no close at all"));
  ok("nomark: reassures nothing was sold", h.includes("Nothing has been sold"));
  const tiles = els.tiles.innerHTML;
  ok("nomark: account tile says incomplete", tiles.includes("at cost — incomplete"));
  ok("nomark: vs-SPY refuses", tiles.includes("needs every position priced"));
  ok("nomark: position COUNT still full", tiles.includes(">2<"),
     "the count tile is the proof nothing was liquidated");
}

// --------------------------------------------- a skipped day is not backfilled
{
  // 08-18, not 08-19: the outage repair below purges 08-19/20/21, and this
  // test is about markCurve's guard, not the repair.
  const { api } = go({ ...book(NOMARK), curve: [{ d: "2026-08-18", v: 105000, spy: 760 }] });
  await sleep(60);
  ok("nomark: an existing curve is left alone", api.state.curve.length === 1 &&
     api.state.curve[0].d === "2026-08-18" &&
     api.state.curve[0].v === 105000 && api.state.curve[0].spy === 760,
     "must not overwrite the last good mark with an incomplete one -- the VALUE "
     + "matters, not just the date: " + JSON.stringify(api.state.curve));
}

// --------------------------------------- one-time repair of the outage marks
// markCurve's guard stops NEW bad points; it cannot reach the ones already in
// localStorage. Marks on 08-19/20/21 were computed with cost basis standing in
// for up to 43% of the book, cannot be recomputed, and are deleted.
{
  const curve = [
    { d: "2026-08-18", v: 101000, spy: 750 },   // clean, must survive
    { d: "2026-08-19", v: 96000,  spy: 752 },   // outage
    { d: "2026-08-20", v: 78000,  spy: 755 },   // outage -- the visible "dump"
    { d: "2026-08-21", v: 79000,  spy: 758 },   // outage
  ];
  const { api } = go({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  const days = api.state.curve.map(p => p.d);
  ok("repair: the clean mark survives", days.includes("2026-08-18"));
  ok("repair: all three outage marks are gone",
     !["2026-08-19", "2026-08-20", "2026-08-21"].some(d => days.includes(d)),
     days.join(","));
  // The repair runs BEFORE markCurve, so a book the current file can fully
  // price gets a correct mark written straight back. Asserted against
  // PX.as_of rather than a literal date: the earlier version of this pinned
  // "2026-08-21" and broke the moment as_of rolled forward, which is nightly.
  ok("repair: a correct mark is written back for the current as_of",
     days.includes(api.PX.as_of), `as_of=${api.PX.as_of} days=${days.join(",")}`);
  ok("repair: that mark is freshly computed, not a resurrected outage total",
     ![96000, 78000, 79000].includes(
       api.state.curve.find(p => p.d === api.PX.as_of).v));
  ok("repair: spy0 is left alone", api.state.spy0 === 700,
     "SPY was priced on all three days -- the benchmark leg was never wrong");
  ok("repair: what was removed is recorded",
     JSON.stringify(api.state.curveRepaired) ===
     JSON.stringify(["2026-08-19", "2026-08-20", "2026-08-21"]));
}
{
  // Idempotent, and it must not eat marks written AFTER the repair ran.
  const curve = [{ d: "2026-08-20", v: 78000, spy: 755 }];
  const { api, store } = go({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  const first = JSON.parse(store["simdesk_v1"]);
  ok("repair: tagged so it runs once", first.repaired === "outage-2026-08");
  const { api: api2 } = go(first);
  await sleep(60);
  ok("repair: a second load removes nothing further",
     api2.state.curve.length === api.state.curve.length,
     `${api.state.curve.length} -> ${api2.state.curve.length}`);
}
{
  // A book that predates the outage entirely is untouched.
  const curve = [{ d: "2026-07-01", v: 100500, spy: 700 },
                 { d: "2026-07-02", v: 100900, spy: 702 }];
  const { api } = go({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  ok("repair: an unaffected account keeps every mark",
     api.state.curve.filter(p => p.d.startsWith("2026-07")).length === 2);
  ok("repair: nothing disclosed when nothing was removed",
     !api.state.curveRepaired);
}
{
  // The gap has to be VISIBLE. A chart draws straight through a missing day.
  const curve = [{ d: "2026-08-18", v: 101000, spy: 750 },
                 { d: "2026-08-19", v: 96000, spy: 752 },
                 { d: "2026-08-20", v: 78000, spy: 755 }];
  const { api, els } = go({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  const f = els.chartFoot.innerHTML;
  ok("repair: the footer names the removed days",
     f.includes("2026-08-19") && f.includes("2026-08-20"), f);
  ok("repair: the footer says why", f.includes("cost basis"));
  ok("repair: a re-derived day is NOT reported as removed",
     !f.includes("2026-08-21"),
     "08-21 came back from a complete price file -- claiming it was lost is wrong");
  void api;
}

// ------------------------------------------------------------ trading guards
{
  const { api, el, g } = go(book(STALE), { confirm: false });
  await sleep(60);
  el("ticker").value = T_STALE; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("stale sell: asks first", g.__confirms.length === 1 && g.__confirms[0].includes(STALE_DATE));
  ok("stale sell: declining does nothing", api.state.lots[T_STALE].qty === 200);
}
{
  const { api, el, g } = go(book(STALE), { confirm: true });
  await sleep(60);
  el("ticker").value = T_STALE; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("stale sell: accepting fills", Math.abs(api.state.lots[T_STALE].qty - 190) < 1e-9);
  const tr = api.state.trades[api.state.trades.length - 1];
  ok("stale sell: logged with the REAL fill date", tr.fill === STALE_DATE + " close (stale)", tr.fill);
}
{
  const { api, el, g } = go(book(NOMARK));
  await sleep(60);
  el("ticker").value = T_NONE; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("nomark sell: refused with an explanation",
     g.__alerts.length === 1 && g.__alerts[0].includes("shares are safe"));
  ok("nomark sell: position untouched", api.state.lots[T_NONE].qty === 300);
}

// ------------------------------------------------------------- header line
{
  const { els } = go(book(FRESH));
  await sleep(60);
  ok("header: states carried-forward count",
     els.asof.innerHTML.includes("carrying an earlier close"), els.asof.innerHTML);
}

// ------------------------------------------------- published file contract
//
// The blocks above inject their own prices so they cannot rot. THIS block is
// the one that reads the real committed prices.json, and it is why running
// this suite in CI after the push is worth anything: it checks the SHAPE the
// front end depends on, without asserting a single number that moves.
{
  const p = PRICES;
  const has = k => p[k] != null;
  ok("published: has as_of", typeof p.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.as_of),
     String(p.as_of));
  ok("published: has prices, prev, themes, names", ["prices","prev","themes","names"].every(has));
  ok("published: has a stale map", p.stale != null && typeof p.stale === "object",
     "the front end reads PX.stale on every row -- a missing key silently marks everything fresh");
  ok("published: has a coverage block", p.coverage != null &&
     ["universe","priced","fresh","stale","fresh_pct","floor","spy_fresh"]
       .every(k => p.coverage[k] != null),
     JSON.stringify(p.coverage));
  ok("published: SPY is priced", p.prices.SPY > 0,
     "SPY is the benchmark leg of every vs-SPY number on both pages");
  ok("published: every stale ticker is also priced",
     Object.keys(p.stale).every(t => p.prices[t] != null),
     "a ticker marked stale but absent from prices would badge a date onto a row with no mark");
  ok("published: every stale date predates as_of",
     Object.entries(p.stale).every(([, d]) => d < p.as_of),
     "a stale date equal to as_of is not stale -- see the prune in fetch_prices.py");
  ok("published: coverage.priced matches the prices map",
     p.coverage.priced === Object.keys(p.prices).length,
     `${p.coverage.priced} vs ${Object.keys(p.prices).length}`);
  ok("published: coverage.stale matches the stale map",
     p.coverage.stale === Object.keys(p.stale).length,
     `${p.coverage.stale} vs ${Object.keys(p.stale).length}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
