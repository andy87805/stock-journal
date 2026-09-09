"""把最上層的個人資料搬進 users/{uid}/ 底下（單人版 → 多人版的一次性搬遷）。

原本 trades、positions 這些集合都放在最上層，只有一個人用所以沒問題。
加入第二個使用者之後，個人資料必須分開，不然兩個人的交易會混在一起。

搬遷之後：
  users/{uid}/trades、positions、lots、realized、options、dividends、settings、syncMeta
最上層保留（市場資料，所有人共用，不需要搬）：
  quotes、symbols、fx、calendarEvents

用法（預設只看不動，確認筆數對了再加 --apply）：
  python sync/migrate_to_multiuser.py --uid <UID>
  python sync/migrate_to_multiuser.py --uid <UID> --apply

搬完並且在 App 上確認資料都在之後，才刪掉最上層的舊資料：
  python sync/migrate_to_multiuser.py --uid <UID> --delete-old

分成兩步是故意的：複製完舊資料還在原地，出錯可以直接重跑，
不會出現「搬一半、兩邊都不完整」的狀態。
"""
import argparse
import os
import sys

# 個人資料，要搬進 users/{uid}/
PERSONAL = ("trades", "positions", "lots", "realized", "options", "dividends", "settings", "syncMeta")

# 市場資料，留在最上層共用（列在這裡只是為了讓範圍一目瞭然，程式不會動它們）
SHARED = ("quotes", "symbols", "fx", "calendarEvents")

BATCH_LIMIT = 450  # Firestore 單批上限 500


def count_all(db):
    return {coll: len(list(db.collection(coll).list_documents())) for coll in PERSONAL}


def copy_collections(db, uid, apply_changes):
    root = db.collection("users").document(uid)
    total = 0
    for coll in PERSONAL:
        docs = list(db.collection(coll).stream())
        if not docs:
            print(f"  {coll}: 0 筆，跳過")
            continue

        if not apply_changes:
            print(f"  {coll}: {len(docs)} 筆待複製")
            total += len(docs)
            continue

        batch = db.batch()
        pending = 0
        for doc in docs:
            batch.set(root.collection(coll).document(doc.id), doc.to_dict())
            pending += 1
            if pending >= BATCH_LIMIT:
                batch.commit()
                batch = db.batch()
                pending = 0
        if pending:
            batch.commit()
        print(f"  {coll}: 已複製 {len(docs)} 筆")
        total += len(docs)
    return total


def verify(db, uid):
    """逐個集合比對筆數。不一致就回報，不要自己「修好」——
    數量對不上代表複製過程出了事，該重跑而不是繼續往下刪舊資料。"""
    root = db.collection("users").document(uid)
    ok = True
    for coll in PERSONAL:
        old = len(list(db.collection(coll).list_documents()))
        new = len(list(root.collection(coll).list_documents()))
        mark = "OK" if old == new else "不一致"
        if old != new:
            ok = False
        print(f"  {coll}: 舊 {old} / 新 {new}  {mark}")
    return ok


def delete_old(db):
    total = 0
    for coll in PERSONAL:
        docs = list(db.collection(coll).list_documents())
        if not docs:
            continue
        batch = db.batch()
        pending = 0
        for ref in docs:
            batch.delete(ref)
            pending += 1
            if pending >= BATCH_LIMIT:
                batch.commit()
                batch = db.batch()
                pending = 0
        if pending:
            batch.commit()
        print(f"  {coll}: 已刪除 {len(docs)} 筆")
        total += len(docs)
    return total


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--uid", required=True, help="要把資料搬給誰（Firebase Console → Authentication → Users）")
    parser.add_argument("--apply", action="store_true", help="真的執行複製（預設只列出筆數）")
    parser.add_argument("--delete-old", action="store_true", help="複製並確認無誤後，刪掉最上層的舊資料")
    args = parser.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from firestore_client import init_firestore

    db = init_firestore()

    if args.delete_old:
        print(f"[migrate] 先比對 users/{args.uid} 與最上層的筆數：")
        if not verify(db, args.uid):
            raise SystemExit(
                "筆數不一致，不刪舊資料。請先重跑一次 --apply（重複執行是安全的，"
                "document ID 沿用舊的，同一筆只會被覆蓋不會變成兩筆）。"
            )
        print("[migrate] 筆數一致，開始刪除最上層舊資料：")
        n = delete_old(db)
        print(f"[migrate] 已刪除 {n} 筆最上層舊資料")
        print(f"[migrate] 最上層保留的共用資料沒有動：{', '.join(SHARED)}")
        return

    print(f"[migrate] 目標：users/{args.uid}")
    n = copy_collections(db, args.uid, args.apply)
    if args.apply:
        print(f"[migrate] 共複製 {n} 筆，開始比對：")
        ok = verify(db, args.uid)
        print(f"[migrate] 比對{'通過' if ok else '不通過，請重跑一次'}")
        print("[migrate] 舊資料還在最上層。到 App 上確認資料都正常之後，再跑 --delete-old")
    else:
        print(f"[migrate] 共 {n} 筆待複製。確認筆數合理後加上 --apply 真的執行")


if __name__ == "__main__":
    main()
