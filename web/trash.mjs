// The caller supplies a Firestore transaction; archive and deletion commit together.
export async function archiveTrade(tx, sourceRef, trashRef, deletedAt, checkSession) {
  const source = await tx.get(sourceRef);
  const archived = await tx.get(trashRef);
  checkSession();
  if (!source.exists()) return false;
  if (archived.exists()) throw new Error("垃圾桶識別碼重複，尚未刪除，請重試。");
  tx.set(trashRef, { collection: "trades", sourceId: sourceRef.id, data: source.data(), deletedAt });
  tx.delete(sourceRef);
  return true;
}

export async function restoreTrade(tx, trashRef, sourceForId, checkSession) {
  const archived = await tx.get(trashRef);
  if (!archived.exists()) throw new Error("這筆紀錄已還原或不在垃圾桶。");
  const item = archived.data();
  if (item.collection !== "trades" || typeof item.sourceId !== "string" || !item.sourceId ||
      item.sourceId.includes("/") || !item.data || typeof item.data !== "object" || Array.isArray(item.data)) {
    throw new Error("垃圾桶資料格式異常，未進行還原。");
  }
  const sourceRef = sourceForId(item.sourceId);
  const current = await tx.get(sourceRef);
  checkSession();
  if (current.exists()) throw new Error("原交易已存在（可能已重新匯入），不覆蓋；垃圾桶備份仍保留。");
  tx.set(sourceRef, item.data);
  tx.delete(trashRef);
  return true;
}
