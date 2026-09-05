"""
共用 Firestore 存取層。broker 同步腳本 (shioaji_sync.py / schwab_sync.py / calendar_sync.py)
都透過這裡的函式寫入資料，確保 document ID 產生規則與 SCHEMA.md 一致。
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

BASE_DIR = Path(__file__).parent
SERVICE_ACCOUNT_FILE = BASE_DIR / "config" / "firebase-service-account.json"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def init_firestore():
    """本機執行讀 config/firebase-service-account.json；GitHub Actions 等雲端環境用
    FIREBASE_SERVICE_ACCOUNT 環境變數（服務帳戶 JSON 的原始字串內容，同名環境變數優先）。"""
    if not firebase_admin._apps:
        raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if raw:
            cred = credentials.Certificate(json.loads(raw))
        else:
            cred = credentials.Certificate(str(SERVICE_ACCOUNT_FILE))
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


def set_sync_meta(db, broker: str, success: bool, error: str | None):
    data = {
        "lastSyncAt": _now_iso(),
        "lastSuccess": success,
        "lastError": error,
    }
    db.collection("syncMeta").document(broker).set(data, merge=True)
