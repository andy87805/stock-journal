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

test("invalid dates and malformed amounts are reported instead of becoming zero", () => {
  const base = { Action: "Buy", Symbol: "TEST", Quantity: "1", Price: "$10", Amount: "-$10", Date: "02/28/2026" };
  for (const change of [{ Date: "02/30/2026" }, { Price: "unknown" }, { Quantity: "1,2" }, { Amount: "Infinity" }]) {
    const p = parse([{ ...base, ...change }]);
    assert.equal(p.trades.length, 0);
    assert.equal(p.unclassified.length, 1);
  }
  assert.equal(parse([{ ...base, Date: "02/29/2024" }]).trades.length, 1);
  assert.throws(() => ctx.parseSchwabExport({ unrelated: [] }));
});

test("malformed option strike and expiry are not accepted", () => {
  for (const symbol of ["TEST 02/30/2026 100 C", "TEST 12/18/2026 10.2.3 C"]) {
    assert.equal(parse([{ ...option("Sell to Open", "$200"), Symbol: symbol }]).unclassified.length, 1);
  }
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
test("verified split pairs require both legs and exact quantities", () => {
  const legs = [
    { Action: "Stock Split", Symbol: "ANET", Date: "12/04/2024", Quantity: "8" },
    { Action: "Stock Split Adj", Symbol: "040413106", Date: "12/04/2024", Quantity: "-2" },
  ];
  assert.equal(parse(legs).unclassified.length, 0);
  assert.equal(parse(legs).trades.length, 0);
  assert.equal(parse([legs[0]]).unclassified.length, 1);
  assert.equal(parse([legs[0], { ...legs[1], Quantity: "-3" }]).unclassified.length, 2);
  assert.equal(parse([...legs, legs[0]]).unclassified.length, 3);
  assert.equal(parse([legs[0], { ...legs[1], Amount: "$1" }]).unclassified.length, 2);
  assert.equal(parse(legs.map(r => ({ ...r, Date: "12/05/2024" }))).unclassified.length, 2);
});

test("reverse split preserves cost and precedes effective-day sale", () => {
  const t = (side, quantity, price, day) => ({ broker: "schwab", market: "US", symbol: "ETH", side, quantity, price, tradeDate: new Date(day) });
  const trades = [t("buy", 50, 3, "2024-10-01"), t("sell", 2, 40, "2024-11-20")];
  const book = ctx.computeBook(trades);
  assert.equal(book.issues.length, 0);
  assert.equal(book.positions[0].shares, 3);
  assert.equal(book.positions[0].avgCost, 30);
  assert.equal(book.lots[0].realizedPnL, 20);
  assert.equal(book.positions[0].shares * book.positions[0].avgCost + book.lots[0].costBasis, 150);
  assert.equal(ctx.computeBook(trades).positions[0].shares, 3);
  assert.equal(trades.length, 2);
  assert.equal(ctx.computeBook([t("buy", 5, 30, "2024-11-20")]).positions[0].shares, 5);
  assert.equal(ctx.computeBook([t("buy", 51, 3, "2024-10-01")]).issues.length, 1);
  const pair = parse([
    { Action: "Reverse Split", Symbol: "ETH", Date: "11/20/2024", Quantity: "5" },
    { Action: "Reverse Split", Symbol: "38964R104", Date: "11/20/2024", Quantity: "-50" },
  ]);
  assert.equal(pair.unclassified.length, 0);
  assert.equal(pair.trades.length, 0);
});

test("split runs before same-day purchase and rejects invalid ratios", () => {
  const t = (side, quantity, day) => ({ broker: "schwab", market: "US", symbol: "ANET", side, quantity, price: 100, tradeDate: new Date(day) });
  const book = ctx.computeBook([t("buy", 2, "2024-01-01"), t("buy", 1, "2024-12-04")]);
  assert.equal(book.positions[0].shares, 9);
  const explicit = { ...t("split", 0, "2024-12-04"), splitRatio: 4 };
  assert.equal(ctx.computeBook([t("buy", 2, "2024-01-01"), explicit]).positions[0].shares, 8);
  assert.equal(ctx.computeBook([t("buy", 2, "2024-01-01"), { ...explicit, splitRatio: 0 }]).issues.length, 1);
});

const adjustedRows = () => [
  { Action: "Sell to Open", Symbol: "TSLL 12/19/2025 22.00 C", Quantity: "5", Amount: "$500", Date: "11/25/2025" },
  { Action: "Assigned", Symbol: "TSLL1 12/19/2025 22.00 C", Quantity: "5", Amount: "", Date: "12/19/2025" },
  { Action: "Assigned", Symbol: "", Description: "5 TSLL1 12/19/2025 22.00 C", Quantity: "", Amount: "-$289.70", Date: "12/19/2025" },
];

test("TSLL1 cash leg closes once and event replay preserves realized cashflow", () => {
  const rows = adjustedRows();
  const before = JSON.stringify(rows);
  const p = parse(rows);
  assert.equal(p.unclassified.length, 0);
  assert.equal(p.options.length, 1);
  const o = p.options[0];
  assert.equal(o.id, "schwab_TSLL_2025-12-19_22_C");
  assert.equal(o.remainingContracts, 0);
  assert.ok(Math.abs(o.realizedPnl - 210.30) < 0.000001);
  assert.equal(o.events.length, 2);
  assert.equal(o.events[1].SourceEvents.length, 2);
  assert.equal(parse(o.events).options[0].realizedPnl, o.realizedPnl);
  assert.equal(JSON.stringify(rows), before);
});

test("TSLL1 missing duplicate wrong-date or incorrect cash legs remain blocked", () => {
  const rows = adjustedRows();
  for (const sample of [rows.slice(0, 2), [...rows, rows[2]],
    [rows[0], rows[1], { ...rows[2], Amount: "-$1" }],
    [rows[0], rows[1], { ...rows[2], Date: "12/18/2025" }],
    [rows[0], rows[1], { ...rows[2], Amount: "$289.70" }],
    [rows[0], rows[1], { ...rows[2], Description: "4 TSLL1 12/19/2025 22.00 C" }]]) {
    assert.ok(parse(sample).unclassified.length > 0);
  }
});

test("TSLL1 expiration links pre-adjustment opening but never a new standard contract", () => {
  const rows = adjustedRows();
  const expired = { ...rows[1], Action: "Expired" };
  assert.equal(parse([rows[0], expired]).options[0].realizedPnl, 500);
  assert.ok(parse([{ ...rows[0], Date: "12/11/2025" }, expired]).unclassified.length);
  assert.ok(parse([expired]).unclassified.length);
  assert.equal(ctx.parseSchwabExport({ BrokerageTransactions: rows }, ["TSLL"]).options.length, 0);
});

test("FFIE old CUSIP is ignored only when FFIE was explicitly excluded", () => {
  const rows = [{ Action: "Reverse Split", Symbol: "307359703", Quantity: "-100", Date: "08/19/2024" }];
  assert.equal(parse(rows).unclassified.length, 1);
  const p = ctx.parseSchwabExport({ BrokerageTransactions: rows }, ["FFIE"]);
  assert.equal(p.unclassified.length, 0);
  assert.equal(p.skippedBySymbol, 1);
});

test("CMCSA spinoff cost is quarantined only for holdings across distribution", () => {
  const t = (side, day, symbol = "CMCSA") => ({ broker: "schwab", market: "US", symbol, side, quantity: 10, price: 30, tradeDate: new Date(day) });
  const original = [t("buy", "2025-01-01"), t("buy", "2025-01-01", "OTHER")];
  const result = ctx.computeBook(original);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].symbol, "CMCSA");
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].symbol, "OTHER");
  assert.equal(original.length, 2);
  assert.equal(ctx.computeBook([t("buy", "2025-01-01"), t("sell", "2026-01-02")]).issues.length, 0);
  assert.equal(ctx.computeBook([t("buy", "2026-01-05")]).issues.length, 0);
});

test("VSNT cash in lieu requests basis and is never classified as dividend or profit", () => {
  const p = parse([{ Action: "Cash In Lieu", Symbol: "VSNT", Date: "01/06/2026 as of 01/02/2026", Amount: "$15.47" }]);
  assert.equal(p.trades.length, 0);
  assert.equal(p.dividends.length, 0);
  assert.equal(p.unclassified.length, 1);
  assert.match(p.unclassified[0].why, /15.47/);
  assert.match(p.unclassified[0].why, /成本/);
});

test("stale prices unavailable and manual quotes isolated", () => {
  ctx.state.quotes["US:TEST"] = { price: 100, updatedAt: new Date().toISOString() };
  assert.equal(ctx.quoteFor("US", "TEST").price, 100);
  ctx.state.personalQuotes["US:TEST"] = { price: 110, updatedAt: new Date().toISOString() };
  assert.equal(ctx.quoteFor("US", "TEST").price, 110);
  assert.equal(ctx.state.quotes["US:TEST"].price, 100);
  ctx.state.personalQuotes["US:TEST"].updatedAt = "2000-01-01";
  assert.equal(ctx.quoteFor("US", "TEST").price, 100);
  ctx.state.quotes["US:TEST"].updatedAt = "2000-01-01";
  assert.equal(ctx.quoteFor("US", "TEST"), null);
});
test("imports target only personal collections", async () => {
  const writes = [];
  const c = vm.createContext({
    Date, parseSchwabDate: () => "2026-01-01",
    session: { uid: "test" },
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

test("legacy adjusted option document blocks import before writes", async () => {
  let commits = 0;
  const c = vm.createContext({ Date, session: { uid: "test" },
    contractKey: o => "schwab_" + o.underlying + "_2025-12-19_22_C",
    myDoc: (name, id) => name + "/" + id,
    getDoc: async () => ({ exists: () => true }),
    commitInBatches: async () => { commits++; },
  });
  vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
  await assert.rejects(c.importSchwab({ unclassified: [], trades: [], dividends: [], names: {},
    options: [{ id: "original", adjustment: { symbol: "TSLL1" } }] }), /調整合約/);
  assert.equal(commits, 0);
});

test("option overwrite requires all prior events including duplicate occurrences", async () => {
  const opening = option("Sell to Open", "$200");
  const closing = option("Buy to Close", "-$50");
  for (const [oldRows, newRows, allowed] of [
    [[opening, closing], [opening], false],
    [[opening, opening], [opening], false],
    [[opening], [opening, closing], true],
    [[opening, closing], [opening, closing], true],
    [[], [opening], false],
    [[opening], [{ ...opening, Amount: "$201" }], false],
  ]) {
    let commits = 0;
    const c = vm.createContext({ Date, session: { uid: "test" },
      parseSchwabDate: v => v,
      myDoc: (name, id) => name + "/" + id,
      getDoc: async () => ({ exists: () => true, data: () => ({ openDate: "2026-01-02", events: oldRows }) }),
      commitInBatches: async () => { commits++; },
    });
    vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
    const run = c.importSchwab({ unclassified: [], trades: [], dividends: [], names: {},
      range: { from: "2020-01-01", to: "2026-12-31" }, options: [{ id: "same", events: newRows }] });
    if (allowed) await run; else await assert.rejects(run, /既有選擇權事件/);
    assert.equal(commits, allowed ? 1 : 0);
  }
});

test("merged adjustment source events compare equal to original legs", async () => {
  const rows = adjustedRows();
  let commits = 0;
  const c = vm.createContext({ Date, session: { uid: "test" }, parseSchwabDate: v => v,
    myDoc: (name, id) => name + "/" + id,
    getDoc: async () => ({ exists: () => true, data: () => ({ events: rows }) }),
    commitInBatches: async () => { commits++; },
  });
  vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
  await c.importSchwab({ unclassified: [], trades: [], dividends: [], names: {},
    range: { from: "2020-01-01", to: "2026-12-31" },
    options: [{ id: "same", events: [rows[0], { ...rows[1], SourceEvents: [rows[1], rows[2]] }] }] });
  assert.equal(commits, 1);
});

test("import conflict preflight writes nothing", async () => {
  let commits = 0;
  const c = vm.createContext({ Date, session: { uid: "test" },
    myDoc: (name, id) => name + "/" + id,
    getDoc: async () => ({ exists: () => true, data: () => ({ symbol: "DIFFERENT" }) }),
    commitInBatches: async () => { commits++; },
  });
  vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
  await assert.rejects(c.importSchwab({ unclassified: [], options: [], dividends: [], names: {},
    trades: [{ symbol: "TEST", externalId: "same" }] }), /ID/);
  assert.equal(commits, 0);
});

test("changing accounts during preflight stops all writes", async () => {
  let commits = 0;
  const session = { uid: "first" };
  const c = vm.createContext({ Date, session,
    myDoc: (name, id) => name + "/" + id,
    getDoc: async () => { session.uid = "second"; return { exists: () => false }; },
    commitInBatches: async () => { commits++; },
  });
  vm.runInContext(section("async function importSchwab(", "/* ---------- charts"), c);
  await assert.rejects(c.importSchwab({ unclassified: [], options: [{ id: "option" }], dividends: [], names: {}, trades: [] }), /帳號/);
  assert.equal(commits, 0);
});

test("failed import reports confirmed batches without claiming rollback", async () => {
  let commits = 0;
  const c = vm.createContext({ session: { uid: "first" }, BATCH_LIMIT: 1, db: {},
    writeBatch: () => ({ set() {}, commit: async () => { if (++commits === 2) throw Error("network"); } }),
  });
  vm.runInContext(section("async function commitInBatches(", "async function importSchwab("), c);
  await assert.rejects(c.commitInBatches([{ ref: "one", data: {} }, { ref: "two", data: {} }]), /已確認寫入 1 \/ 2.*本批結果未確認/);
  assert.equal(commits, 2);
});

test("account change on final import batch cannot report success", async () => {
  const session = { uid: "first" };
  const c = vm.createContext({ session, BATCH_LIMIT: 450, db: {},
    writeBatch: () => ({ set() {}, commit: async () => { session.uid = "second"; } }),
  });
  vm.runInContext(section("async function commitInBatches(", "async function importSchwab("), c);
  await assert.rejects(c.commitInBatches([{ ref: "one", data: {} }]), /帳號已變更/);
});

test("delete halts after account switch and reports uncertain failure", async () => {
  for (const mode of ["switch", "failure", "signed-out"]) {
    let commits = 0;
    const session = { uid: mode === "signed-out" ? null : "first" };
    const c = vm.createContext({ session, BATCH_LIMIT: 1, db: {},
      writeBatch: () => ({ delete() {}, commit: async () => {
        commits++;
        if (mode === "switch") session.uid = "second";
        if (mode === "failure") throw Error("network");
      } }),
    });
    vm.runInContext(section("async function deleteDocsInBatches(", "/* ---------- 嘉信匯出檔解析"), c);
    await assert.rejects(c.deleteDocsInBatches(["one", "two"]), mode === "failure" ? /本批結果未確認/ : /帳號已變更/);
    assert.equal(commits, mode === "signed-out" ? 0 : 1);
  }
});

test("changing accounts between batches stops remaining writes", async () => {
  let commits = 0;
  const session = { uid: "first" };
  const c = vm.createContext({ session, BATCH_LIMIT: 1, db: {},
    writeBatch: () => ({ set() {}, commit: async () => { commits++; session.uid = "second"; } }),
  });
  vm.runInContext(section("async function commitInBatches(", "async function importSchwab("), c);
  await assert.rejects(c.commitInBatches([{ ref: "one", data: {} }, { ref: "two", data: {} }]), /帳號/);
  assert.equal(commits, 1);
});
