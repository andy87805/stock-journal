"""永豐證券（Shioaji）同步：庫存、已實現損益、現價 → Firestore。

## 為什麼不用 list_trades()

實測（`shioaji_selftest.py`）確認 `list_trades()` 只回傳「透過 API 這個連線下的單」，
在永豐 App/網頁手動下的成交它一筆都看不到。永豐也沒有任何原始成交明細的 API，
能拿到的只有券商已經算好的結果，所以這支腳本改成：

- `list_positions()`      → 庫存、均價、現價、未實現損益
- `list_position_detail(id)` → 各批買進日與成本、累計配息（永豐沒有股利 API，只能靠這個）
- `list_profit_loss()`    → 每次平倉的已實現損益（有平倉日）
- `list_profit_loss_detail(id)` → 各批進場日與成本，用來算加權平均進場日與持有天數

id 是 0..n-1 的連續索引，實測可以正確選到對應那一筆的明細。

## 單位地雷

`quantity` 是**張**，零股會顯示 0（不是沒有股票）。所以金額一律用明細的總額欄位加總，
不要用 `quantity × 1000` 回推股數。

環境變數：SHIOAJI_API_KEY、SHIOAJI_API_SECRET、FIREBASE_SERVICE_ACCOUNT
只需要金鑰的「帳務 + 正式環境」權限，不需要「交易」權限，也不需要 CA 憑證。
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

BROKER = "sinopac"
MARKET = "TW"
CURRENCY = "TWD"
DEFAULT_LOOKBACK_DAYS = 1825  # 5 年
WINDOW_DAYS = 364  # 永豐限制單次查詢不得超過 12 個月


def _f(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _date_str(value):
    """明細的 date 欄位實測是 'YYYY-MM-DD' 字串，但保險起見也接受 date 物件。"""
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m-%d")
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def weighted_entry_date(details):
    """用成本對進場日加權，算出這批平倉的「平均進場日」。

    算不出來就回 None——沒有可靠進場日時寧可讓持有天數留空，也不要填一個看起來
    很準其實是猜的數字。
    """
    total_cost = 0.0
    weighted = 0.0
    for d in details:
        day = _date_str(getattr(d, "date", None))
        cost = _f(getattr(d, "cost", 0))
        if not day or cost <= 0:
            continue
        try:
            ordinal = datetime.strptime(day, "%Y-%m-%d").date().toordinal()
        except ValueError:
            continue
        weighted += ordinal * cost
        total_cost += cost
    if total_cost <= 0:
        return None
    return date.fromordinal(round(weighted / total_cost)).isoformat()


def build_positions(api, account):
    """庫存 + 逐檔明細。

    明細除了加總成本/配息，本身就是「各批買進紀錄」（有買進日期），一併回傳存成 lots，
    交易紀錄頁的買進資料就是靠這個。
    """
    positions = []
    quotes = []
    open_lots = []
    undated = 0
    for pos in api.list_positions(account):
        symbol = str(getattr(pos, "code", "")).strip()
        if not symbol:
            continue

        avg_price = _f(getattr(pos, "price", 0))
        last_price = _f(getattr(pos, "last_price", 0))
        unrealized = _f(getattr(pos, "pnl", 0))
        cond = getattr(getattr(pos, "cond", None), "value", None) or str(getattr(pos, "cond", "Cash"))

        total_cost = 0.0
        ex_dividends = 0.0
        entry_dates = []
        try:
            for lot_index, det in enumerate(api.list_position_detail(account, getattr(pos, "id", 0))):
                # 明細的 price 是「該批總成本」，不是單價
                lot_cost = _f(getattr(det, "price", 0))
                lot_dividends = _f(getattr(det, "ex_dividends", 0))
                total_cost += lot_cost
                ex_dividends += lot_dividends
                day = _date_str(getattr(det, "date", None))
                if day:
                    entry_dates.append(day)
                else:
                    # 沒有日期也要建立批次。之前跳過會讓成本進了 totalCost 卻沒有對應批次，
                    # 批次加總就對不上部位（實測 00891 因此少 5,295 元）。
                    undated += 1
                open_lots.append(
                    {
                        "symbol": symbol,
                        "market": MARKET,
                        "currency": CURRENCY,
                        "status": "open",
                        "tradeDate": day or None,
                        "lots": _f(getattr(det, "quantity", 0)),
                        "cost": round(lot_cost, 2),
                        "unitPrice": None,  # 庫存明細只給總額，沒有單價
                        "fee": _f(getattr(det, "fee", 0)),
                        "exDividends": round(lot_dividends, 2),
                        "dseq": str(getattr(det, "dseq", "") or ""),
                        "seq": lot_index,
                    }
                )
        except Exception as exc:
            print(f"  [warn] {symbol} 庫存明細讀取失敗，改用均價推估總成本: {exc}")

        if total_cost <= 0:
            # 沒有明細可用時的退路：張數 × 1000 × 均價（零股會低估，只當備援）
            total_cost = _f(getattr(pos, "quantity", 0)) * 1000 * avg_price

        positions.append(
            {
                "symbol": symbol,
                "market": MARKET,
                "currency": CURRENCY,
                "lots": _f(getattr(pos, "quantity", 0)),
                "avgPrice": avg_price,
                "lastPrice": last_price,
                "totalCost": round(total_cost, 2),
                "marketValue": round(total_cost + unrealized, 2),
                "unrealizedPnl": round(unrealized, 2),
                "exDividends": round(ex_dividends, 2),
                "earliestEntryDate": min(entry_dates) if entry_dates else None,
                "cond": cond,
            }
        )

        if last_price > 0:
            quotes.append({"symbol": symbol, "price": last_price})

    if undated:
        print(f"  [warn] {undated} 筆庫存明細沒有日期，仍建立批次但 tradeDate 留空")
    return positions, quotes, open_lots


def build_realized(api, account, begin, end):
    """每次平倉的已實現損益 + 逐筆明細（明細用來算進場成本與加權進場日）。

    永豐限制單次查詢區間不得超過 12 個月，所以切成一年一段再合併。
    明細是用 id 對應「最近一次 list_profit_loss 的結果」，因此每一段都必須
    當場把明細抓完才能查下一段，不能先收集所有紀錄最後再統一抓明細。
    """
    records = []
    closed_lots = []
    window_start = begin
    while window_start <= end:  # <= 才不會漏掉最後一天（當天平倉的交易）
        window_end = min(window_start + timedelta(days=WINDOW_DAYS), end)
        window_records, window_lots = _build_realized_window(api, account, window_start, window_end)
        records.extend(window_records)
        closed_lots.extend(window_lots)
        window_start = window_end + timedelta(days=1)
    return records, closed_lots


def _build_realized_window(api, account, begin, end):
    records = []
    closed_lots = []
    for pnl in api.list_profit_loss(account, begin.isoformat(), end.isoformat()):
        symbol = str(getattr(pnl, "code", "")).strip()
        sell_date = _date_str(getattr(pnl, "date", None))
        dseq = str(getattr(pnl, "dseq", "") or getattr(pnl, "seqno", "") or "").strip()
        if not symbol or not sell_date or not dseq:
            print(f"  [warn] 跳過缺少 symbol/date/dseq 的紀錄: {pnl}")
            continue

        entry_cost = 0.0
        fee = 0.0
        tax = 0.0
        ex_dividend_amt = 0.0
        entry_date = None
        try:
            details = list(api.list_profit_loss_detail(account, getattr(pnl, "id", 0)))
            for det in details:
                lot_cost = _f(getattr(det, "cost", 0))
                lot_dividends = _f(getattr(det, "ex_dividend_amt", 0))
                entry_cost += lot_cost
                fee += _f(getattr(det, "fee", 0))
                tax += _f(getattr(det, "tax", 0))
                ex_dividend_amt += lot_dividends
                # 這些明細就是該次平倉對應的各批進場紀錄，存下來當交易紀錄的買進資料
                day = _date_str(getattr(det, "date", None))
                if day:
                    closed_lots.append(
                        {
                            "symbol": symbol,
                            "market": MARKET,
                            "currency": CURRENCY,
                            "status": "closed",
                            "tradeDate": day,
                            "lots": _f(getattr(det, "quantity", 0)),
                            "cost": round(lot_cost, 2),
                            "unitPrice": _f(getattr(det, "price", 0)) or None,
                            "fee": _f(getattr(det, "fee", 0)),
                            "exDividends": round(lot_dividends, 2),
                            "dseq": str(getattr(det, "dseq", "") or ""),
                        }
                    )
            entry_date = weighted_entry_date(details)
        except Exception as exc:
            print(f"  [warn] {symbol} {sell_date} 損益明細讀取失敗: {exc}")

        holding_days = None
        if entry_date:
            try:
                holding_days = (
                    datetime.strptime(sell_date, "%Y-%m-%d").date()
                    - datetime.strptime(entry_date, "%Y-%m-%d").date()
                ).days
            except ValueError:
                holding_days = None

        records.append(
            {
                "symbol": symbol,
                "market": MARKET,
                "currency": CURRENCY,
                "sellDate": sell_date,
                "lots": _f(getattr(pnl, "quantity", 0)),
                "sellPrice": _f(getattr(pnl, "price", 0)),
                "pnl": round(_f(getattr(pnl, "pnl", 0)), 2),
                "prRatio": _f(getattr(pnl, "pr_ratio", 0)),
                "entryCost": round(entry_cost, 2),
                "fee": round(fee, 2),
                "tax": round(tax, 2),
                "exDividendAmt": round(ex_dividend_amt, 2),
                "entryDate": entry_date,
                "holdingDays": holding_days,
                "dseq": dseq,
            }
        )
    return records, closed_lots


def generate_dry_run_data():
    today = date.today()
    positions = [
        {
            "symbol": "0050",
            "market": MARKET,
            "currency": CURRENCY,
            "lots": 9,
            "avgPrice": 47.15,
            "lastPrice": 109.9,
            "totalCost": 424350.0,
            "marketValue": 989069.0,
            "unrealizedPnl": 564719.0,
            "exDividends": 12787.0,
            "earliestEntryDate": "2025-06-18",
            "cond": "Cash",
        },
        {
            # 零股：lots 是 0 但確實有股票，金額要看 totalCost
            "symbol": "2330",
            "market": MARKET,
            "currency": CURRENCY,
            "lots": 0,
            "avgPrice": 1165.48,
            "lastPrice": 1480.0,
            "totalCost": 58274.0,
            "marketValue": 122458.0,
            "unrealizedPnl": 64184.0,
            "exDividends": 0.0,
            "earliestEntryDate": "2026-01-15",
            "cond": "Cash",
        },
    ]
    realized = [
        {
            "symbol": "0056",
            "market": MARKET,
            "currency": CURRENCY,
            "sellDate": (today - timedelta(days=30)).isoformat(),
            "lots": 7,
            "sellPrice": 35.61,
            "pnl": 119306.0,
            "prRatio": 0.9223,
            "entryCost": 230197.0,
            "fee": 328.0,
            "tax": 784.0,
            "exDividendAmt": 41827.0,
            "entryDate": "2021-11-03",
            "holdingDays": 1487,
            "dseq": "X04XM",
        },
        {
            # 明細讀不到進場日時的樣子：entryDate / holdingDays 留 None，不填假值
            "symbol": "00893",
            "market": MARKET,
            "currency": CURRENCY,
            "sellDate": (today - timedelta(days=5)).isoformat(),
            "lots": 1,
            "sellPrice": 39.48,
            "pnl": 24026.0,
            "prRatio": 1.5644,
            "entryCost": 46060.0,
            "fee": 0.0,
            "tax": 0.0,
            "exDividendAmt": 0.0,
            "entryDate": None,
            "holdingDays": None,
            "dseq": "X08PP",
        },
    ]
    quotes = [{"symbol": p["symbol"], "price": p["lastPrice"]} for p in positions]
    lots = [
        {
            "symbol": "0050", "market": MARKET, "currency": CURRENCY, "status": "open",
            "tradeDate": "2025-06-18", "lots": 6, "cost": 243594.0, "unitPrice": None,
            "fee": 0.0, "exDividends": 12787.0, "dseq": "",
        },
        {
            # 零股批次：lots 是 0，所以介面不能拿張數當「有沒有交易」的判斷
            "symbol": "0050", "market": MARKET, "currency": CURRENCY, "status": "open",
            "tradeDate": "2025-07-02", "lots": 0, "cost": 4760.0, "unitPrice": None,
            "fee": 0.0, "exDividends": 0.0, "dseq": "",
        },
        {
            "symbol": "0056", "market": MARKET, "currency": CURRENCY, "status": "closed",
            "tradeDate": "2021-05-26", "lots": 0, "cost": 1984.0, "unitPrice": 34.3,
            "fee": 10.0, "exDividends": 1311.0, "dseq": "E722X",
        },
    ]
    return positions, realized, quotes, lots


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="不連券商也不寫 Firestore，印出符合 SCHEMA.md 的範例資料",
    )
    parser.add_argument("--days", type=int, default=DEFAULT_LOOKBACK_DAYS, help="已實現損益往回查幾天")
    args = parser.parse_args()

    if args.dry_run:
        positions, realized, quotes, lots = generate_dry_run_data()
        print(json.dumps(
            {"positions": positions, "realized": realized, "quotes": quotes, "lots": lots},
            ensure_ascii=False, indent=2))
        return

    from firestore_client import (
        init_firestore,
        replace_open_lots,
        replace_positions,
        set_sync_meta,
        upsert_closed_lot,
        upsert_quote,
        upsert_realized,
        user_root,
    )

    api_key = os.environ.get("SHIOAJI_API_KEY")
    api_secret = os.environ.get("SHIOAJI_API_SECRET")
    if not api_key or not api_secret:
        raise SystemExit("需要 SHIOAJI_API_KEY / SHIOAJI_API_SECRET")

    db = init_firestore()
    # 個人資料（庫存/批次/已實現/同步狀態）寫進 users/{uid}/；
    # 現價是市場資料，留在最上層共用。
    root = user_root(db)

    try:
        import shioaji as sj

        api = sj.Shioaji()
        api.login(api_key=api_key, secret_key=api_secret)
        account = api.stock_account
        if account is None:
            raise RuntimeError("拿不到證券帳戶，請確認金鑰有「帳務」與「正式環境」權限")

        end = date.today()
        begin = end - timedelta(days=args.days)

        positions, quotes, open_lots = build_positions(api, account)
        realized, closed_lots = build_realized(api, account, begin, end)

        written, stale = replace_positions(root, BROKER, positions)
        print(f"[shioaji_sync] 庫存 {written} 檔（清掉 {stale} 筆已不存在）")

        for record in realized:
            upsert_realized(root, BROKER, record)
        print(f"[shioaji_sync] 已實現損益 {len(realized)} 筆（{begin} ~ {end}）")

        lots_written, lots_stale = replace_open_lots(root, BROKER, open_lots)
        print(f"[shioaji_sync] 持有中買進批次 {lots_written} 筆（清掉 {lots_stale} 筆已不存在）")

        for lot in closed_lots:
            upsert_closed_lot(root, BROKER, lot)
        print(f"[shioaji_sync] 已平倉的進場批次 {len(closed_lots)} 筆")

        for quote in quotes:
            upsert_quote(db, MARKET, quote["symbol"], quote["price"], BROKER)
        print(f"[shioaji_sync] 現價 {len(quotes)} 檔")

        no_entry = [r["symbol"] for r in realized if r["holdingDays"] is None]
        if no_entry:
            print(f"[shioaji_sync] 這些平倉紀錄拿不到進場日，持有天數留空: {', '.join(no_entry)}")

        set_sync_meta(root, BROKER, True, None)

        try:
            api.logout()
        except Exception:
            # logout 只是連線收尾，失敗不影響已寫入的資料
            pass

    except Exception as exc:
        set_sync_meta(root, BROKER, False, f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
