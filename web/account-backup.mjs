export const PERSONAL_COLLECTIONS = ["trades", "positions", "lots", "realized", "options", "dividends",
  "settings", "quotes", "symbols", "syncMeta", "assetSnapshots", "trash", "importRuns", "cashflows"];
export async function buildPersonalBackup({ uid, currentUid, readCollection }) {
  const check = () => { if (!uid || currentUid() !== uid) throw new Error("帳號已變更，已停止備份。"); };
  check();
  const result = { format: "stock-journal-personal-backup", version: 1, uid,
    startedAt: new Date().toISOString(), consistency: "sequential-read-not-atomic", collections: {}, importChanges: {} };
  for (const name of PERSONAL_COLLECTIONS) {
    check();
    result.collections[name] = await readCollection(name);
    check();
  }
  for (const run of result.collections.importRuns) {
    if (!run.id || run.id.includes("/")) throw new Error("匯入紀錄識別碼異常，備份中止。");
    check();
    result.importChanges[run.id] = await readCollection("importRuns/" + run.id + "/changes");
    check();
  }
  result.finishedAt = new Date().toISOString();
  return result;
}
