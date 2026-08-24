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
import { run } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  -- " + extra : ""));
  if (!cond) fails++;
};

// A book with one fresh name, one carrying an earlier close (WBS, 2026-08-20),
// and one with no close at all (EA, dropped by the feed).
const book = (lots) => ({
  cash: 10000, lots, trades: [], curve: [], spy0: null, created: "2026-08-01",
});

const FRESH = { MSFT: { qty: 100, cost: 40000 } };
const STALE = { MSFT: { qty: 100, cost: 40000 }, WBS: { qty: 200, cost: 14000 } };
const NOMARK = { MSFT: { qty: 100, cost: 40000 }, EA: { qty: 300, cost: 30000 } };

// ---------------------------------------------------------------- fresh book
{
  const { api, els } = run(book(FRESH));
  await sleep(60);
  const t = api.totals();
  ok("fresh: nothing flagged", t.unpriced === 0 && t.staleMV === 0);
  ok("fresh: MV is qty x close",
     Math.abs(t.pos - 100 * 483.24) < 0.01, `pos=${t.pos}`);
  ok("fresh: a curve point IS written", api.state.curve.length === 1,
     JSON.stringify(api.state.curve));
  ok("fresh: no notice banner", !els.positions.innerHTML.includes("notice"));
  ok("fresh: vs-SPY tile is live", !els.tiles.innerHTML.includes("needs every position priced"));
}

// ------------------------------------------------------- carried-forward name
{
  const { api, els } = run(book(STALE));
  await sleep(60);
  const t = api.totals();
  ok("stale: staleAt returns the ticker's own date", api.staleAt("WBS") === "2026-08-20");
  ok("stale: priced at the REAL close, not cost",
     Math.abs(t.pos - (100 * 483.24 + 200 * 77.57)) < 0.01, `pos=${t.pos}`);
  ok("stale: not counted as unpriced", t.unpriced === 0);
  ok("stale: staleMV reported", Math.abs(t.staleMV - 200 * 77.57) < 0.01);
  ok("stale: a curve point IS still written", api.state.curve.length === 1,
     "a real older close is a usable mark");
  const h = els.positions.innerHTML;
  ok("stale: row badged with its date", h.includes("badge stale") && h.includes("2026-08-20"));
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
  ok("stale: last close still shown", cell(staleRow, 5).includes("$77.57"));
  ok("stale: P&L computed off the real close, not zeroed",
     cell(staleRow, 8).includes("$") && !cell(staleRow, 8).includes("+$0<"));
  // A missing number is not a loss. Both of these fell through to .neg and
  // painted an em dash red.
  ok("stale: the suppressed day change is dim, not red",
     /class="dim"/.test(staleRow.split("<td")[6]), staleRow.split("<td")[6]);
}

// ------------------------------------------------------------- no mark at all
{
  const { api, els } = run(book(NOMARK));
  await sleep(60);
  const t = api.totals();
  ok("nomark: counted", t.unpriced === 1);
  ok("nomark: falls back to cost", Math.abs(t.pos - (100 * 483.24 + 30000)) < 0.01);
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
  const { api } = run({ ...book(NOMARK), curve: [{ d: "2026-08-18", v: 105000, spy: 760 }] });
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
  const { api } = run({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  const days = api.state.curve.map(p => p.d);
  ok("repair: the clean mark survives", days.includes("2026-08-18"));
  ok("repair: 08-19 and 08-20 are gone",
     !days.includes("2026-08-19") && !days.includes("2026-08-20"), days.join(","));
  ok("repair: 08-21 is re-derived, not merely dropped",
     days.includes("2026-08-21"), "the file can price the whole book again");
  ok("repair: the re-derived 08-21 is a real mark, not the old total",
     api.state.curve.find(p => p.d === "2026-08-21").v !== 79000);
  ok("repair: spy0 is left alone", api.state.spy0 === 700,
     "SPY was priced on all three days -- the benchmark leg was never wrong");
  ok("repair: what was removed is recorded",
     JSON.stringify(api.state.curveRepaired) ===
     JSON.stringify(["2026-08-19", "2026-08-20", "2026-08-21"]));
}
{
  // Idempotent, and it must not eat marks written AFTER the repair ran.
  const curve = [{ d: "2026-08-20", v: 78000, spy: 755 }];
  const { api, store } = run({ ...book(FRESH), curve, spy0: 700 });
  await sleep(60);
  const first = JSON.parse(store["simdesk_v1"]);
  ok("repair: tagged so it runs once", first.repaired === "outage-2026-08");
  const { api: api2 } = run(first);
  await sleep(60);
  ok("repair: a second load removes nothing further",
     api2.state.curve.length === api.state.curve.length,
     `${api.state.curve.length} -> ${api2.state.curve.length}`);
}
{
  // A book that predates the outage entirely is untouched.
  const curve = [{ d: "2026-07-01", v: 100500, spy: 700 },
                 { d: "2026-07-02", v: 100900, spy: 702 }];
  const { api } = run({ ...book(FRESH), curve, spy0: 700 });
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
  const { api, els } = run({ ...book(FRESH), curve, spy0: 700 });
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
  const { api, el, g } = run(book(STALE), { confirm: false });
  await sleep(60);
  el("ticker").value = "WBS"; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("stale sell: asks first", g.__confirms.length === 1 && g.__confirms[0].includes("2026-08-20"));
  ok("stale sell: declining does nothing", api.state.lots.WBS.qty === 200);
}
{
  const { api, el, g } = run(book(STALE), { confirm: true });
  await sleep(60);
  el("ticker").value = "WBS"; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("stale sell: accepting fills", Math.abs(api.state.lots.WBS.qty - 190) < 1e-9);
  const tr = api.state.trades[api.state.trades.length - 1];
  ok("stale sell: logged with the REAL fill date", tr.fill === "2026-08-20 close (stale)", tr.fill);
}
{
  const { api, el, g } = run(book(NOMARK));
  await sleep(60);
  el("ticker").value = "EA"; el("mode").value = "sh"; el("amount").value = "10";
  api.sell();
  ok("nomark sell: refused with an explanation",
     g.__alerts.length === 1 && g.__alerts[0].includes("shares are safe"));
  ok("nomark sell: position untouched", api.state.lots.EA.qty === 300);
}

// ------------------------------------------------------------- header line
{
  const { els } = run(book(FRESH));
  await sleep(60);
  ok("header: states carried-forward count",
     els.asof.innerHTML.includes("carrying an earlier close"), els.asof.innerHTML);
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
