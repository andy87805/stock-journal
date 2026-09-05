"""
更新 Firestore `calendarEvents`（除權息日 + 財報日提醒）。
symbol 清單直接從既有 `trades` collection 撈（不需要另外維護一份股票清單）。

環境變數：FINNHUB_API_KEY（美股財報日用，免費 Finnhub 帳號即可申請）
台股除權息用 TWSE 公開資料，不需要 API key。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

BROKER = "calendar"

# TWSE 開放資料的確切路徑偶爾會變動，使用前請對照 https://openapi.twse.com.tw/ 最新清單確認這條路徑還有效，
# 以及下面猜測的欄位名稱（公司代號／除權除息交易日）是否與實際回傳一致。
TWSE_EX_DIVIDEND_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap45_L"
FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings"


def generate_dry_run_events():
    today = datetime.now(timezone.utc).date().isoformat()
    return [
        {"symbol": "2330", "market": "TW", "type": "exDividend", "eventDate": today},
        {"symbol": "0050", "market": "TW", "type": "exDividend", "eventDate": today},
        {"symbol": "AAPL", "market": "US", "type": "earnings", "eventDate": today},
    ]


def collect_symbols(db):
    tw_symbols, us_symbols = set(), set()
    for doc in db.collection("trades").where("market", "==", "TW").stream():
        symbol = doc.to_dict().get("symbol")
        if symbol:
            tw_symbols.add(symbol)
    for doc in db.collection("trades").where("market", "==", "US").stream():
        symbol = doc.to_dict().get("symbol")
        if symbol:
            us_symbols.add(symbol)
    return tw_symbols, us_symbols


def fetch_tw_ex_dividend_events(tw_symbols):
    if not tw_symbols:
        return []
    resp = requests.get(TWSE_EX_DIVIDEND_URL, timeout=30)
    resp.raise_for_status()
    raw = resp.json()

    events = []
    for row in raw:
        symbol = row.get("公司代號") or row.get("Code")
        ex_date = row.get("除權除息交易日") or row.get("ExDividendTradingDate")
        if symbol not in tw_symbols or not ex_date:
            continue
        events.append(
            {
                "symbol": symbol,
                "market": "TW",
                "type": "exDividend",
                "eventDate": ex_date,
            }
        )
    return events


def fetch_us_earnings_events(us_symbols, api_key):
    if not us_symbols or not api_key:
        return []
    today = datetime.now(timezone.utc).date()
    end = today + timedelta(days=30)
    events = []
    for symbol in us_symbols:
        resp = requests.get(
            FINNHUB_EARNINGS_URL,
            params={"from": today.isoformat(), "to": end.isoformat(), "symbol": symbol, "token": api_key},
            timeout=30,
        )
        resp.raise_for_status()
        raw = resp.json()
        for item in raw.get("earningsCalendar", []):
            events.append(
                {
                    "symbol": item.get("symbol", symbol),
                    "market": "US",
                    "type": "earnings",
                    "eventDate": item.get("date"),
                }
            )
    return events


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不連線任何 API/Firestore，只印出範例資料")
    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps(generate_dry_run_events(), ensure_ascii=False, indent=2))
        return

    from firestore_client import init_firestore, set_sync_meta, upsert_calendar_event

    db = init_firestore()
    try:
        tw_symbols, us_symbols = collect_symbols(db)

        events = []
        try:
            events += fetch_tw_ex_dividend_events(tw_symbols)
        except Exception as e:
            print(f"[calendar_sync] TWSE 除權息資料查詢失敗（略過，不中斷同步）: {e}", file=sys.stderr)

        finnhub_key = os.environ.get("FINNHUB_API_KEY")
        try:
            events += fetch_us_earnings_events(us_symbols, finnhub_key)
        except Exception as e:
            print(f"[calendar_sync] Finnhub 財報日資料查詢失敗（略過，不中斷同步）: {e}", file=sys.stderr)

        for event in events:
            upsert_calendar_event(db, event)

        set_sync_meta(db, BROKER, True, None)
        print(f"[calendar_sync] 同步完成，共 {len(events)} 筆行事曆事件")
    except Exception as e:
        set_sync_meta(db, BROKER, False, str(e))
        raise


if __name__ == "__main__":
    main()
