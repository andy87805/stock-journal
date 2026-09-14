// Read-only diagnostics. Unknown values never become a zero difference.
const finite = v => v !== null && v !== undefined && Number.isFinite(v);
export function reconcile({ positions = [], lots = [], book }) {
  const rows = [];
  for (const p of positions) {
    const matches = lots.filter(l => l.broker === p.broker && l.market === p.market && l.symbol === p.symbol && l.status === "open");
    const unique = positions.filter(x => x.broker === p.broker && x.market === p.market && x.symbol === p.symbol).length === 1;
    const detailCost = unique && matches.length && matches.every(l => finite(l.cost))
      ? matches.reduce((sum, l) => sum + l.cost, 0) : null;
    const messages = [];
    if (!unique) messages.push("同代號有多種庫存條件，批次尚不能可靠分組");
    if (!matches.length) messages.push("缺少持有中批次明細");
    if (matches.some(l => !l.tradeDate)) messages.push("部分批次缺少買進日期");
    if (!finite(p.totalCost)) messages.push("券商尚未提供有效成本");
    const delta = finite(p.totalCost) && finite(detailCost) ? detailCost - p.totalCost : null;
    if (delta !== null && Math.abs(delta) > 0.01) messages.push("庫存成本與批次成本不一致，需核對批次缺漏或同步時間");
    messages.push("批次缺少精確股數，尚不能獨立核對股數及損益");
    rows.push({ ...p, brokerShares: finite(p.shares) ? p.shares : null,
      appShares: null, brokerCost: finite(p.totalCost) ? p.totalCost : null, appCost: detailCost,
      brokerPnl: finite(p.unrealizedPnl) ? p.unrealizedPnl : null, appPnl: null,
      costDelta: delta, messages, sourceLabel: "券商庫存 ↔ 同來源批次加總（非獨立對帳）" });
  }
  for (const p of book.positions) {
    rows.push({ ...p, brokerShares: null, appShares: p.shares, brokerCost: null,
      appCost: p.shares * p.avgCost, brokerPnl: null, appPnl: null, costDelta: null,
      messages: ["缺少券商庫存對帳基準，不能判定一致；需提供同日股數、成本及損益明細"],
      sourceLabel: "App 交易計算 ↔ 券商基準尚未取得" });
  }
  for (const issue of book.issues) {
    rows.push({ ...issue, currency: issue.market === "TW" ? "TWD" : "USD",
      brokerShares: null, appShares: null, brokerCost: null, appCost: null,
      brokerPnl: null, appPnl: null, costDelta: null, messages: [issue.message], sourceLabel: "計算暫停，待補資料" });
  }
  return rows;
}
