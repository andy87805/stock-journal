import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const ctx = vm.createContext({
  DAY_MS: 86400000, Date, console,
  positionKey: t => t.market + ":" + t.symbol,
  state: { personalQuotes: {}, quotes: {} },
  parseDate: value => value ? new Date(value) : null,
  symbolKey: (market, symbol) => market + ":" + symbol,
});
vm.runInContext(section("const SCHWAB_ACTIONS", "const BATCH_LIMIT"), ctx);
vm.runInContext(section("function computeBook(", "const marketValue ="), ctx);
const parse = rows => ctx.parseSchwabExport({ BrokerageTransactions: rows });
const option = (Action, Amount, Quantity = "1", Date = "01/02/2026") => ({
  Action, Amount, Quantity, Date, Symbol: "TEST 12/18/2026 100.00 C",
});
test("comma quantity and distinct identical fills survive repeated parsing", () => {
  const row = { Action: "Buy", Amount: "-$100", Quantity: "1,000", Price: "$0.10", Date: "01/02/2026", Symbol: "TEST" };
  const first = parse([row, row]).trades;
  assert.equal(first[0].quantity, 1000);
  assert.notEqual(first[0].externalId, first[1].externalId);
  assert.deepEqual(first.map(t => t.externalId), parse([row, row]).trades.map(t => t.externalId));
});
test("option closing cashflow is included", () => {
  const p = parse([option("Sell to Open", "$200"), option("Buy to Close", "-$50")]);
  assert.equal(p.options[0].realizedPnl, 150);
  assert.equal(p.options[0].contracts, 1);
  assert.equal(p.options[0].remainingContracts, 0);
});
test("multiple openings and partial close preserve outstanding premium", () => {
  const p = parse([option("Sell to Open", "$200"), option("Sell to Open", "$300"), option("Buy to Close", "-$50")]);
  assert.equal(p.options[0].realizedPnl, 200);
  assert.equal(p.options[0].openPremium, 250);
  assert.equal(p.options[0].contracts, 1);
  assert.equal(p.options[0].status, "open");
});
test("short history and corporate actions block rather than fabricate", () => {
  assert.equal(parse([option("Buy to Close", "-$50")]).unclassified.length, 1);
  assert.equal(parse([{ Action: "Reverse Split", Symbol: "TEST", Date: "01/02/2026" }]).unclassified.length, 1);
});
test("ignore list covers option underlying", () => {
  assert.equal(ctx.parseSchwabExport({ BrokerageTransactions: [option("Sell to Open", "$200")] }, ["TEST"]).options.length, 0);
});
test("overselling isolates the symbol without silently truncating shares", () => {
  const t = (side, quantity) => ({ market: "US", symbol: "TEST", side, quantity, price: 100, tradeDate: new Date("2026-01-01") });
  const result = ctx.computeBook([t("buy", 10), t("sell", 15), { ...t("buy", 5), symbol: "OTHER" }]);
  assert.equal(result.issues[0].symbol, "TEST");
  assert.equal(result.lots.length, 0);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].symbol, "OTHER");
  assert.equal(ctx.computeBook([t("buy", 10), t("sell", 5)]).positions[0].shares, 5);
});

test("verified ANET split preserves cost and is applied once per calculation", () => {
  const t = (side, quantity, price, day) => ({ broker: "schwab", market: "US", symbol: "ANET", side, quantity, price, tradeDate: new Date(day) });
  const trades = [t("buy", 2, 100, "2023-01-06"), t("sell", 2, 120, "2025-11-25"), t("sell", 4, 140, "2026-01-28")];
  const result = ctx.computeBook(trades);
  assert.equal(result.issues.length, 0);
  assert.equal(result.positions[0].shares, 2);
  assert.equal(result.positions[0].avgCost, 25);
  assert.equal(result.lots.reduce((s, l) => s + l.costBasis, 0) + 2 * 25, 200);
  assert.equal(ctx.computeBook(trades).positions[0].shares, 2);
  assert.equal(trades.length, 3);
  assert.equal(ctx.computeBook([t("buy", 2, 100, "2025-01-06")]).positions[0].shares, 2);
});
test("stale prices unavailable and manual quotes isolated", () => {
  ctx.state.quotes["US:TEST"] = { price: 100, updatedAt: new Date().toISOString() };
  assert.equal(ctx.quoteFor("US", "TEST").price, 100);
  ctx.state.personalQuotes["US:TEST"] = { price: 110, updatedAt: new Date().toISOString() };
  assert.equal(ctx.quoteFor("US", "TEST").price, 110);
  assert.equal(ctx.state.quotes["US:TEST"].price, 100);
  ctx.state.personalQuotes["US:TEST"].updatedAt = "2000-01-01";
  assert.equal(ctx.quoteFor("US", "TEST"), null);
});
test("imports target only personal collections", async () => {
  const writes = [];
  const c = vm.createContext({
    Date, parseSchwabDate: () => "2026-01-01",
    symbolKey: (market, symbol) => market + ":" + symbol,
    myDoc: (name, id) => "users/test/" + name + "/" + id,
    getDoc: async () => ({ exists: () => false }),
    commitInBatches: async list => writes.push(...list),
  });
  vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
  await c.importSchwab({ unclassified: [], trades: [], dividends: [], options: [], names: { TEST: "Test" }, range: {} });
  assert.equal(writes[0].ref, "users/test/symbols/US:TEST");
});

test("delete uses actual ledger shape and never expands symbol scope", async () => {
  const refs = [];
  const c = vm.createContext({
    el: (tag, attrs, children) => ({ tag, ...attrs, children }),
    confirm: () => true,
    myDoc: (name, id) => name + "/" + id,
    deleteDocsInBatches: async list => refs.push(...list),
  });
  vm.runInContext(section("function deleteFilteredPanel(", "/* ---------- 設定"), c);
  const panel = c.deleteFilteredPanel([
    { symbol: "TEST", trade: { id: "one" } },
    { symbol: "TEST", trade: null },
  ]);
  await panel.children[1].onclick();
  assert.deepEqual(refs, ["trades/one"]);
});
