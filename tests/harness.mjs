// Runs docs/index.html's real page script under Node against the real
// docs/data/prices.json, with a fabricated book. No browser, no build step —
// `node tests/check.mjs` from the repo root.
//
// The script is extracted from the <script> block rather than duplicated, so a
// test can never pass against a copy of the logic that shipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");
const PRICES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs", "data", "prices.json"), "utf8"));

const src = HTML.split("<script>")[1].split("</script>")[0];

function makeEl(id) {
  return { id, innerHTML: "", textContent: "", value: "",
           addEventListener() {}, querySelectorAll: () => [] };
}

export { PRICES };

export function run(book, opts = {}) {
  const els = {};
  const store = {};
  const g = {
    document: { getElementById: id => (els[id] ||= makeEl(id)) },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    fetch: async () => ({ json: async () => JSON.parse(JSON.stringify(PRICES)) }),
    alert: m => { g.__alerts.push(m); },
    confirm: m => { g.__confirms.push(m); return opts.confirm ?? true; },
    prompt: () => "harness",
    AbortSignal: { timeout: () => null },
    console,
    __alerts: [], __confirms: [],
  };
  g.window = g;
  // Pre-seeded so trader() never reaches its prompt().
  store["simdesk_trader"] = "harness";
  store["simdesk_v1"] = JSON.stringify(book);

  // discoverSimApi() would hit the network on every run.
  const patched = src.replace("async function discoverSimApi() {",
                              "async function discoverSimApi() { return;");

  const fn = new Function(...Object.keys(g), patched +
    "\n;return {totals,markCurve,renderTiles,renderPositions,renderChart,quote," +
    "buy,sell,staleAt,price,get state(){return state},get PX(){return PX}};");
  const api = fn(...Object.values(g));
  // els is populated lazily by getElementById, so tests go through this.
  const el = id => g.document.getElementById(id);
  return { api, els, el, store, g };
}
