export function validateCashflow(input, today) {
  const { date, currency, direction } = input;
  const parsed = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== date || date > today) throw new Error("請填寫有效且非未來的日期。");
  if (!["TWD", "USD"].includes(currency) || !["deposit", "withdrawal"].includes(direction)) throw new Error("幣別或入出金類型無效。");
  const text = String(input.amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("金額請輸入正數，最多兩位小數，不含千分位符號。");
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new Error("金額超出可記錄範圍。");
  return { date, currency, direction, amount, note: String(input.note || "").trim().slice(0, 300), source: "manual", status: "active" };
}
export function cashflowTotals(rows) {
  const totals = { TWD: 0, USD: 0 };
  for (const row of rows) {
    if (row.status !== "active" || !Object.hasOwn(totals, row.currency) ||
        !["deposit", "withdrawal"].includes(row.direction) || !Number.isFinite(row.amount) || row.amount <= 0) continue;
    totals[row.currency] += row.direction === "deposit" ? row.amount : -row.amount;
  }
  return totals;
}
