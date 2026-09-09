"""更新 Firestore `quotes` 的美股現價。

台股現價由 shioaji_sync.py 從券商庫存直接帶出來，美股沒有券商 API 可用
（嘉信開發者平台申請不到），所以另外抓。前端不自己抓是因為瀏覽器直連這些
端點會被 CORS 擋掉，離線時也拿不到。

主要來源是 Yahoo 的行情端點，免 API key。它是非官方介面，壞掉的話用 Finnhub
（已經有 FINNHUB_API_KEY）當備援。兩個都失敗就跳過那一檔，讓前端顯示「未估值」，
不要拿舊價或猜的數字充數。
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

BROKER = "quotes"
MARKET = "US"
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
FINNHUB_URL = "https://finnhub.io/api/v1/quote"
UA = {"User-Agent": "Mozilla/5.0 (compatible; stock-journal/1.0)"}


# 券商與 Yahoo 對同一檔的寫法不一致。每一條都要查證是同一家公司才能加，
# 配錯就是把別人的股價填到你的部位上，而畫面看起來完全正常。
# 查不到又沒把握的就別配，讓它維持「未估值」，或在 App 裡手動填。
YAHOO_ALIASES = {
    "BRKB": "BRK-B",
    "PBRA": "PBR-A",
    # EchoStar 於 2026-06-24 正式把代號由 SATS 改為 ECHO，Yahoo 上 ECHO 的公司名
    # 確認是 EchoStar Corporation（不是同名的 Echo Global Logistics）
    "SATS": "ECHO",
}


def yahoo_symbol(symbol: str) -> str:
    """Yahoo 的 B 股寫法是 BRK-B，券商可能給 BRK/B 或 BRKB。"""
    return YAHOO_ALIASES.get(symbol, symbol.replace("/", "-"))


def fetch_yahoo(symbol: str):
    resp = requests.get(
        YAHOO_URL.format(symbol=yahoo_symbol(symbol)),
        params={"interval": "1d", "range": "1d"},
        headers=UA,
        timeout=20,
    )
    resp.raise_for_status()
    meta = resp.json()["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice")
    return float(price) if price else None


def fetch_finnhub(symbol: str, api_key: str):
    resp = requests.get(
        FINNHUB_URL,
        params={"symbol": yahoo_symbol(symbol), "token": api_key},
        timeout=20,
    )
    resp.raise_for_status()
    price = resp.json().get("c")
    return float(price) if price else None


def collect_us_symbols(db):
    """現價是共用資料，要涵蓋所有使用者的持股，不然另一個人的部位會顯示未估值。

    忽略清單是各自的：A 刪掉某一檔，不該讓還持有它的 B 也沒有現價可用。
    所以只有「所有人都忽略」的代號才真的跳過。
    """
    from firestore_client import all_user_roots

    symbols = set()
    for root in all_user_roots(db):
        settings = root.collection("settings").document("import").get()
        ignored = set((settings.to_dict() or {}).get("ignoredSymbols", []) if settings.exists else [])
        for doc in root.collection("trades").stream():
            d = doc.to_dict()
            if d.get("market") == MARKET and d.get("symbol") and d["symbol"] not in ignored:
                symbols.add(d["symbol"])
    return sorted(symbols)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不連 Firestore，抓幾檔樣本示範")
    parser.add_argument("--delay", type=float, default=0.2, help="每檔之間的間隔秒數")
    args = parser.parse_args()

    if args.dry_run:
        for s in ["AAPL", "TSLA", "BRK/B"]:
            try:
                print(f"  {s}: {fetch_yahoo(s)}")
            except Exception as exc:
                print(f"  {s}: 失敗 {type(exc).__name__}")
        return

    from firestore_client import init_firestore, set_sync_meta_all, upsert_quote

    db = init_firestore()
    try:
        finnhub_key = os.environ.get("FINNHUB_API_KEY", "")
        symbols = collect_us_symbols(db)
        print(f"[quotes_sync] 美股代號 {len(symbols)} 檔")

        ok = 0
        failed = []
        for symbol in symbols:
            price = None
            source = "yahoo"
            try:
                price = fetch_yahoo(symbol)
            except Exception:
                price = None
            if not price and finnhub_key:
                try:
                    price = fetch_finnhub(symbol, finnhub_key)
                    source = "finnhub"
                except Exception:
                    price = None
            if price:
                upsert_quote(db, MARKET, symbol, price, source)
                ok += 1
            else:
                failed.append(symbol)
            time.sleep(args.delay)

        print(f"[quotes_sync] 寫入 {ok} 檔現價")
        if failed:
            # 抓不到就讓前端顯示「未估值」，不要拿舊價充數
            print(f"[quotes_sync] 抓不到現價（維持未估值）: {', '.join(failed)}")
        set_sync_meta_all(db, BROKER, True, None)
    except Exception as exc:
        set_sync_meta_all(db, BROKER, False, f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
