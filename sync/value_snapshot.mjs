import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

// Reuse the PWA accounting engine; fail if its extraction boundaries change.
const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const start = source.indexOf("function computeBook(");
const end = source.indexOf("function quoteFor(", start);
if (start < 0 || end < start) throw Error("Accounting engine not found");
const engine = source.slice(start, end);
const valid = v => typeof v === "number" && Number.isFinite(v);
export function valueSnapshot(data, now = new Date()) {
  const context = vm.createContext({ Date, DAY_MS: 86400000, positionKey: t => t.market + ":" + t.symbol });
  vm.runInContext(engine, context);
  const issues = [];
  const trades = (data.trades || []).map(t => ({ ...t, tradeDate: new Date(t.tradeDate) }));
  if (trades.some(t => !Number.isFinite(+t.tradeDate) || +t.tradeDate > +now)) throw Error("Invalid trade date");
  const book = context.computeBook(trades);
  issues.push(...book.issues.map(i => i.symbol + ":" + i.message));
  const fresh = date => { const age = +now - +new Date(date); return Number.isFinite(age) && age >= -300000 && age <= 4 * 86400000; };
  const holdings = [];
  for (const p of data.positions || []) {
    const usable = fresh(p.syncedAt) && valid(p.shares) && p.shares >= 0 && valid(p.lastPrice) && p.lastPrice > 0;
    holdings.push({ symbol: p.symbol, market: p.market, currency: p.currency, broker: p.broker,
      shares: valid(p.shares) ? p.shares : null, cost: valid(p.totalCost) ? p.totalCost : null,
      marketValue: usable ? p.shares * p.lastPrice : null,
      pnl: usable && valid(p.unrealizedPnl) ? p.unrealizedPnl : null, priceAt: p.syncedAt || null });
  }
  for (const p of book.positions) {
    const key = p.market + ":" + p.symbol.replaceAll("/", "-");
    const q = [data.personalQuotes?.[key], data.quotes?.[key]].find(q => q && fresh(q.updatedAt) && valid(q.price) && q.price > 0);
    const cost = p.shares * p.avgCost;
    holdings.push({ symbol: p.symbol, market: p.market, currency: p.currency, broker: p.broker,
      shares: p.shares, cost, marketValue: q ? p.shares * q.price : null,
      pnl: q ? p.shares * q.price - cost : null, priceAt: q?.updatedAt || null });
  }
  if ((data.options || []).some(o => o.status === "open")) issues.push("未平倉選擇權缺少市值");
  if (holdings.some(p => p.marketValue === null)) issues.push("部分持股缺少有效現價或同步時間");
  if (holdings.some(p => p.cost === null)) issues.push("部分持股缺少成本");
  const fx = data.fx && fresh(data.fx.updatedAt) && valid(data.fx.rate) && data.fx.rate > 0 ? data.fx : null;
  const convert = (amount, currency) => currency === "TWD" ? amount : currency === "USD" && fx ? amount * fx.rate : null;
  const values = holdings.map(p => p.marketValue === null ? null : convert(p.marketValue, p.currency));
  if (values.some(v => v === null)) issues.push("估值或匯率不完整");
  // Cash is not inferred from trade proceeds or settlements.
  issues.push("尚未提供現金餘額，非完整總資產");
  return { schemaVersion: 1, capturedAt: now.toISOString(), holdings, cash: null,
    fx: fx ? { rate: fx.rate, updatedAt: fx.updatedAt, base: "USD", quote: "TWD" } : null,
    knownHoldingsValueTwd: values.reduce((sum, v) => sum + (v ?? 0), 0),
    holdingsComplete: values.every(v => v !== null) && book.issues.length === 0,
    totalAssetsTwd: null, complete: false, issues: [...new Set(issues)] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(valueSnapshot(JSON.parse(fs.readFileSync(0, "utf8"))))); }
  catch { process.stderr.write("Snapshot valuation failed; no private data logged\n"); process.exitCode = 1; }
}
