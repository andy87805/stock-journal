"""更新 Firestore `fx`（匯率）。

總覽要把美股部位換算成台幣跟台股加總，所以需要 USD/TWD。
匯率在同步端抓而不是前端抓：瀏覽器直連匯率 API 有 CORS 問題，離線時也拿不到，
存進 Firestore 之後前端就跟讀現價一樣單純。

來源 open.er-api.com 免費且不需要 API key。抓不到就讓腳本失敗，
前端在沒有匯率時會退回分幣別顯示，不會拿舊值或猜的數字硬算。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import requests

BROKER = "fx"
SOURCE_URL = "https://open.er-api.com/v6/latest/USD"
PAIRS = [("USD", "TWD")]


def fetch_rates(base: str):
    resp = requests.get(SOURCE_URL, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("result") != "success":
        raise RuntimeError(f"匯率 API 回傳非 success：{payload.get('result')} {payload.get('error-type', '')}")
    rates = payload.get("rates") or {}
    if not rates:
        raise RuntimeError("匯率 API 沒有回傳 rates")
    return rates, payload.get("time_last_update_utc", "")


def build_fx():
    records = []
    rates, updated = fetch_rates("USD")
    for base, quote in PAIRS:
        rate = rates.get(quote)
        if not rate:
            raise RuntimeError(f"匯率 API 沒有 {quote} 的匯率")
        records.append(
            {
                "base": base,
                "quote": quote,
                "rate": float(rate),
                "source": "open.er-api.com",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            }
        )
    print(f"[fx_sync] 來源更新時間 {updated}")
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不寫 Firestore，只印出抓到的匯率")
    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps(build_fx(), ensure_ascii=False, indent=2))
        return

    from firestore_client import init_firestore, set_sync_meta_all

    db = init_firestore()
    try:
        for record in build_fx():
            doc_id = f"{record['base']}{record['quote']}"
            db.collection("fx").document(doc_id).set(record)
            print(f"[fx_sync] {doc_id} = {record['rate']}")
        set_sync_meta_all(db, BROKER, True, None)
    except Exception as exc:
        set_sync_meta_all(db, BROKER, False, f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
