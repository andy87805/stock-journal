"""
共用 Firestore 存取層。broker 同步腳本 (shioaji_sync.py / schwab_sync.py / calendar_sync.py)
都透過這裡的函式寫入資料，確保 document ID 產生規則與 SCHEMA.md 一致。
"""
import base64
import binascii
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

BASE_DIR = Path(__file__).parent
SERVICE_ACCOUNT_FILE = BASE_DIR / "config" / "firebase-service-account.json"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def symbol_key(market: str, symbol: str) -> str:
    """代號可能含斜線（BRK/B），而 Firestore 會把斜線當成路徑分隔導致寫入失敗。

    前端 web/app.js 的 symbolKey() 用同一條規則，兩邊產生的 document ID 必須一致，
    否則會變成這邊寫得進去、前端卻查不到。
    """
    return f"{market}:{str(symbol).replace('/', '-')}"


def _parse_service_account(raw):
    """接受 base64 或原始 JSON。

    多行 JSON 貼進 GitHub Secret 欄位容易被前後空白、BOM 之類的東西弄壞，
    base64（單行）比較不會出事，所以兩種都接受：先試 base64，失敗才當原始 JSON。
    """
    text = raw.strip().lstrip("﻿")
    if not text.startswith("{"):
        try:
            text = base64.b64decode(text, validate=True).decode("utf-8").strip().lstrip("﻿")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise SystemExit(
                "FIREBASE_SERVICE_ACCOUNT 既不是合法的 JSON 也不是合法的 base64，"
                f"請重新設定這個 secret（長度 {len(raw)}）：{exc}"
            )
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"FIREBASE_SERVICE_ACCOUNT 解析失敗，內容可能在貼上時被截斷（長度 {len(raw)}）：{exc}"
        )


def init_firestore():
    """本機執行讀 config/firebase-service-account.json；GitHub Actions 等雲端環境用
    FIREBASE_SERVICE_ACCOUNT 環境變數（服務帳戶 JSON，可以是原始內容或 base64）。"""
    if not firebase_admin._apps:
        raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if raw:
            cred = credentials.Certificate(_parse_service_account(raw))
        elif SERVICE_ACCOUNT_FILE.exists():
            cred = credentials.Certificate(str(SERVICE_ACCOUNT_FILE))
        else:
            # GitHub Secrets 是綁單一 repo 的，加在別的 repo 這裡會拿到空值
            raise SystemExit(
                "找不到 Firebase 憑證：環境變數 FIREBASE_SERVICE_ACCOUNT 沒有設定，"
                f"也沒有 {SERVICE_ACCOUNT_FILE}。\n"
                "在 GitHub Actions 上請確認 secret 是加在這個 repo（Settings → "
                "Secrets and variables → Actions），不是加在其他 repo。"
            )
        firebase_admin.initialize_app(cred)
    return firestore.client()


def upsert_trade(db, trade: dict):
    doc_id = f"{trade['broker']}_{trade['externalId']}"
    # note 是使用者在 App 端手動填寫的筆記，同步腳本一律不寫入/不覆寫這個欄位。
    data = {k: v for k, v in trade.items() if k != "note"}
    data["syncedAt"] = _now_iso()
    db.collection("trades").document(doc_id).set(data, merge=True)
    return doc_id


def upsert_dividend(db, dividend: dict):
    doc_id = f"{dividend['broker']}_{dividend['externalId']}"
    data = dict(dividend)
    data["syncedAt"] = _now_iso()
    db.collection("dividends").document(doc_id).set(data, merge=True)
    return doc_id


def upsert_calendar_event(db, event: dict):
    date_only = event["eventDate"][:10]
    doc_id = f"{event['symbol']}_{event['type']}_{date_only}"
    data = dict(event)
    db.collection("calendarEvents").document(doc_id).set(data, merge=True)
    return doc_id


def replace_positions(db, broker: str, positions: list[dict]):
    """整批覆蓋某個 broker 的庫存。

    庫存是「當下狀態」而不是歷史紀錄：賣光的部位必須從 Firestore 消失，
    所以這裡不能只 upsert，要把這次沒出現的舊 doc 刪掉。
    """
    written = set()
    for pos in positions:
        doc_id = f"{broker}_{pos['symbol']}_{pos.get('cond', 'Cash')}"
        data = dict(pos)
        data["broker"] = broker
        data["syncedAt"] = _now_iso()
        db.collection("positions").document(doc_id).set(data)
        written.add(doc_id)

    stale = 0
    for doc in db.collection("positions").where(filter=FieldFilter("broker", "==", broker)).stream():
        if doc.id not in written:
            doc.reference.delete()
            stale += 1
    return len(written), stale


def _lot_doc_id(broker: str, lot: dict):
    """庫存明細的 dseq 實測是空字串，所以 open 批次改用序號當識別。

    原本用成本數值當識別，結果同一天、同一檔、同金額的兩筆買進會撞 ID 互相覆蓋
    （實測 00891 因此少掉 5,295 元，批次加總對不上部位總成本）。
    open 批次每次同步都整批覆蓋，序號只要在單次同步內唯一就夠；
    closed 批次要跨次穩定，而它的 dseq 有值，照用即可。
    """
    key = lot.get("dseq") or f"i{lot.get('seq', 0)}"
    return f"{broker}_{lot['status']}_{lot['symbol']}_{lot['tradeDate']}_{key}"


def replace_open_lots(db, broker: str, lots: list[dict]):
    """整批覆蓋仍持有的買進批次（賣掉了就該從清單消失）。closed 的批次不動。"""
    written = set()
    for lot in lots:
        doc_id = _lot_doc_id(broker, lot)
        data = dict(lot)
        data["broker"] = broker
        data["syncedAt"] = _now_iso()
        db.collection("lots").document(doc_id).set(data)
        written.add(doc_id)

    stale = 0
    query = (
        db.collection("lots")
        .where(filter=FieldFilter("broker", "==", broker))
        .where(filter=FieldFilter("status", "==", "open"))
    )
    for doc in query.stream():
        if doc.id not in written:
            doc.reference.delete()
            stale += 1
    return len(written), stale


def upsert_closed_lot(db, broker: str, lot: dict):
    """已平倉部位的進場批次是歷史紀錄，只增不刪。"""
    doc_id = _lot_doc_id(broker, lot)
    data = dict(lot)
    data["broker"] = broker
    data["syncedAt"] = _now_iso()
    db.collection("lots").document(doc_id).set(data, merge=True)
    return doc_id


def upsert_realized(db, broker: str, record: dict):
    """已實現損益是歷史事實，只增不刪。dseq 實測唯一，加日期防跨年重複。"""
    doc_id = f"{broker}_{record['sellDate']}_{record['dseq']}"
    data = dict(record)
    data["broker"] = broker
    data["syncedAt"] = _now_iso()
    db.collection("realized").document(doc_id).set(data, merge=True)
    return doc_id


def upsert_quote(db, market: str, symbol: str, price: float, source: str):
    doc_id = symbol_key(market, symbol)
    db.collection("quotes").document(doc_id).set(
        {
            "symbol": symbol,
            "market": market,
            "price": price,
            "source": source,
            "updatedAt": _now_iso(),
        },
        merge=True,
    )
    return doc_id


def set_sync_meta(db, broker: str, success: bool, error: str | None):
    data = {
        "lastSyncAt": _now_iso(),
        "lastSuccess": success,
        "lastError": error,
    }
    db.collection("syncMeta").document(broker).set(data, merge=True)
