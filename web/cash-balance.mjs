export function validateCashBalance(input, now = new Date()) {
  if (input.confirmed !== true) throw new Error("請確認已包含所有投資帳戶現金與現金負債。");
  const balances = {};
  for (const currency of ["TWD", "USD"]) {
    const text = String(input[currency] ?? "").trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error("兩種幣別都需填寫金額，沒有餘額請填 0，負債填負數。");
    const amount = Number(text);
    if (!Number.isFinite(amount) || Math.abs(amount) > 1e12) throw new Error("金額超出範圍。");
    balances[currency] = amount;
  }
  return { balances, confirmed: true, asOf: now.toISOString(), source: "manual" };
}
export function cashForSnapshot(record, now = new Date()) {
  if (!record || record.confirmed !== true) return null;
  const time = new Date(record.asOf);
  const taiwanDate = d => new Date(+d + 8 * 3600000).toISOString().slice(0, 10);
  if (!Number.isFinite(+time) || +time > +now || taiwanDate(time) !== taiwanDate(now)) return null;
  if (!["TWD", "USD"].every(c => typeof record.balances?.[c] === "number" && Number.isFinite(record.balances[c]))) return null;
  return { ...record, balances: { ...record.balances } };
}
