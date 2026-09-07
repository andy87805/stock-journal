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

BASE_DIR = Path(__file__).parent
SERVICE_ACCOUNT_FILE = BASE_DIR / "config" / "firebase-service-account.json"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


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
