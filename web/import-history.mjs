// Metadata only: never copy the brokerage export or credentials into the log.
export async function recordImport({ create, update, run, metadata, now = () => new Date().toISOString() }) {
  let confirmed = 0;
  await create({ ...metadata, status: "running", startedAt: now(), confirmed: 0 });
  let result;
  try {
    result = await run(async (done, total) => {
      confirmed = done;
      await update({ confirmed, totalWrites: total });
    }, async audit => update({ audit }));
  } catch (error) {
    try { await update({ status: "interrupted", confirmed, endedAt: now() }); } catch { /* stale running status stays visible */ }
    throw error;
  }
  try {
    await update({ status: "completed", confirmed: result, totalWrites: result, endedAt: now() });
  } catch {
    throw new Error("資料已寫入，但匯入紀錄未能標記完成；請先核對資料，不要直接刪除重來。");
  }
  return result;
}
