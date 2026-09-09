"""更新 Firestore `symbols`（代號 → 名稱）。

介面上只顯示 2330、00891 這種代號很難認，這支腳本把台股名稱抓下來讓前端可以顯示
「台積電 2330」。美股名稱不在這裡，是嘉信匯出檔匯入時從 Description 一併寫入的。

來源是 TWSE 的每日收盤行情（STOCK_DAY_ALL），它同時帶 Code 與 Name，涵蓋上市股票與 ETF，
免費且不需要 API key。上櫃（TPEx）不在這個端點裡，抓不到名稱的代號前端會退回只顯示代號。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import requests

BROKER = "symbols"
TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
MARKET = "TW"


# 債券 ETF 不在 STOCK_DAY_ALL，另一個債券端點 BFT41U 也查不到這兩檔。
# 名稱取自發行商官網與交易所簡稱，發現其他缺漏時往這裡補即可。
MANUAL_NAMES = {
    "00679B": "元大美債20年",
    "00937B": "群益ESG投等債20+",
}


def fetch_tw_symbols():
    resp = requests.get(TWSE_URL, timeout=40)
    resp.raise_for_status()
    rows = resp.json()
    out = []
    seen = set()
    for r in rows:
        code = str(r.get("Code") or "").strip()
        name = str(r.get("Name") or "").strip()
        if code and name:
            out.append({"symbol": code, "market": MARKET, "name": name, "source": "twse"})
            seen.add(code)
    if not out:
        raise RuntimeError("TWSE 沒有回傳任何代號名稱")
    for code, name in MANUAL_NAMES.items():
        if code not in seen:
            out.append({"symbol": code, "market": MARKET, "name": name, "source": "manual"})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不寫 Firestore，只印出抓到的筆數與樣本")
    parser.add_argument(
        "--only-held",
        action="store_true",
        help="只寫入目前有資料的代號（持股/交易/已實現），避免上千筆用不到的名稱佔空間",
    )
    args = parser.parse_args()

    symbols = fetch_tw_symbols()

    if args.dry_run:
        print(f"抓到 {len(symbols)} 筆")
        print(json.dumps(symbols[:5], ensure_ascii=False, indent=2))
        return

    from firestore_client import init_firestore, set_sync_meta, symbol_key

    db = init_firestore()
    try:
        wanted = None
        if args.only_held:
            wanted = set()
            for coll in ("positions", "lots", "realized", "trades"):
                for doc in db.collection(coll).stream():
                    d = doc.to_dict()
                    if d.get("market") == MARKET and d.get("symbol"):
                        wanted.add(d["symbol"])

        written = 0
        batch = db.batch()
        pending = 0
        now = datetime.now(timezone.utc).isoformat()
        for s in symbols:
            if wanted is not None and s["symbol"] not in wanted:
                continue
            ref = db.collection("symbols").document(symbol_key(MARKET, s["symbol"]))
            batch.set(ref, {**s, "updatedAt": now}, merge=True)
            written += 1
            pending += 1
            if pending >= 450:  # Firestore 單批上限 500
                batch.commit()
                batch = db.batch()
                pending = 0
        if pending:
            batch.commit()

        print(f"[symbols_sync] 寫入 {written} 筆代號名稱" + (f"（只寫持有中的 {len(wanted)} 檔）" if wanted is not None else ""))
        set_sync_meta(db, BROKER, True, None)
    except Exception as exc:
        set_sync_meta(db, BROKER, False, f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
