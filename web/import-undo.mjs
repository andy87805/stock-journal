// Deterministic comparison also supports Firestore Timestamp.toJSON().
function canonical(value) {
  if (value && typeof value.toJSON === "function") return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const sameDocument = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export async function journalBatch(tx, runRef, entries, check) {
  const run = await tx.get(runRef);
  if (!run.exists() || run.data().status !== "running") throw new Error("匯入已停止，未繼續寫入。");
  const snapshots = [];
  for (const e of entries) snapshots.push([await tx.get(e.ref), await tx.get(e.journalRef)]);
  check();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], [prior, journal] = snapshots[i];
    if (journal.exists()) throw new Error("匯入寫入紀錄已存在，請先核對。");
    const before = prior.exists() ? prior.data() : null;
    const after = { ...(before || {}), ...e.data };
    tx.set(e.ref, after);
    tx.set(e.journalRef, { collection: e.collection, sourceId: e.ref.id, before, after, reverted: false });
  }
}

export async function undoJournalBatch(tx, runRef, entries, check) {
  const run = await tx.get(runRef);
  if (!run.exists() || run.data().status !== "undoing") throw new Error("撤銷狀態已變更。");
  const snapshots = [];
  for (const e of entries) snapshots.push([await tx.get(e.journalRef), await tx.get(e.ref)]);
  check();
  for (let i = 0; i < entries.length; i++) {
    const [journal, current] = snapshots[i];
    if (!journal.exists()) throw new Error("缺少撤銷紀錄，尚未修改本批。");
    const j = journal.data();
    if (j.reverted) continue;
    if (j.collection !== entries[i].collection || j.sourceId !== entries[i].ref.id ||
        !current.exists() || !sameDocument(current.data(), j.after)) {
      throw new Error("資料在匯入後已修改、刪除或重新匯入，本批不覆蓋；請先對帳。");
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const j = snapshots[i][0].data();
    if (j.reverted) continue;
    if (j.before === null) tx.delete(entries[i].ref);
    else tx.set(entries[i].ref, j.before);
    tx.update(entries[i].journalRef, { reverted: true });
  }
}
