"""
從永豐證券 (SinoPac) 用官方 shioaji SDK 拉成交紀錄，寫入 Firestore `trades` collection。
環境變數：SHIOAJI_API_KEY, SHIOAJI_API_SECRET
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

BROKER = "sinopac"
LOT_SIZE = 1000  # 台股一張 = 1000 股，trades collection 一律存股數不是張數


def generate_dry_run_trades():
    now = datetime.now(timezone.utc).astimezone().isoformat()
    return [
        {
            "broker": BROKER,
            "symbol": "2330",
            "market": "TW",
            "side": "buy",
            "quantity": 1000,
            "price": 590.0,
            "fee": 84,
            "tax": 0,
            "currency": "TWD",
            "tradeDate": now,
            "externalId": "DRYRUN-SINOPAC-0001",
        },
        {
            "broker": BROKER,
            "symbol": "2317",
            "market": "TW",
            "side": "sell",
            "quantity": 2000,
            "price": 108.5,
            "fee": 30,
            "tax": 65,
            "currency": "TWD",
            "tradeDate": now,
            "externalId": "DRYRUN-SINOPAC-0002",
        },
        {
            "broker": BROKER,
            "symbol": "0050",
            "market": "TW",
            "side": "buy",
            "quantity": 1000,
            "price": 138.2,
            "fee": 20,
            "tax": 0,
            "currency": "TWD",
            "tradeDate": now,
            "externalId": "DRYRUN-SINOPAC-0003",
        },
    ]


def fetch_trades(api, sj):
    """實際串接 shioaji SDK 取得成交紀錄。
    下面用到的方法/欄位名稱（update_status / list_trades / status.deals / deal.seqno...）是依
    shioaji 官方文件撰寫當下的認知，實際安裝的 shioaji 版本可能有落差，
    請對照 https://sinotrade.github.io/ 最新文件確認方法名稱與回傳欄位。
    """
    api.update_status(api.stock_account)
    trades = api.list_trades()

    result = []
    for t in trades:
        deals = getattr(t.status, "deals", None) or []
        contract = t.contract
        order = t.order
        for deal in deals:
            quantity = deal.quantity
            # 部分 shioaji 版本可能以「張」為單位回傳整股委託的成交數量，需要乘上 LOT_SIZE 換算成股數；
            # 這裡假設 SDK 回傳的 quantity 已經是股數，實測若發現是張數請自行加上 * LOT_SIZE，
            # 並用實際對帳單核對，零股交易通常本來就是股數不需要換算。
            side = "buy" if order.action == sj.constant.Action.Buy else "sell"
            ts = getattr(deal, "ts", None)
            trade_date = (
                datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat()
                if ts
                else datetime.now(timezone.utc).astimezone().isoformat()
            )
            external_id = str(
                getattr(deal, "seqno", None)
                or getattr(deal, "trade_id", None)
                or f"{contract.code}-{trade_date}-{quantity}"
            )
            result.append(
                {
                    "broker": BROKER,
                    "symbol": contract.code,
                    "market": "TW",
                    "side": side,
                    "quantity": quantity,
                    "price": deal.price,
                    "fee": getattr(order, "fee", 0) or 0,
                    "tax": getattr(order, "tax", 0) or 0,
                    "currency": "TWD",
                    "tradeDate": trade_date,
                    "externalId": external_id,
                }
            )
    return result


def fetch_dividends(api):
    """Shioaji 官方 SDK 目前沒有明確穩定的股利/除權息入帳查詢 API。
    這裡做 best-effort 嘗試，查不到就回傳空列表，不讓整個同步失敗。
    TODO: 永豐證券的股利資料目前需要人工對照庫存表/對帳單確認，
    SDK 是否有對應方法（如未來版本的 list_dividends 之類）請自行對照最新文件查證。
    """
    try:
        if not hasattr(api, "list_dividends"):
            return []
        raw = api.list_dividends(api.stock_account)
    except Exception as e:
        print(f"[shioaji_sync] 股利資料查詢失敗（略過，不中斷同步）: {e}", file=sys.stderr)
        return []

    dividends = []
    for d in raw or []:
        dividends.append(
            {
                "broker": BROKER,
                "symbol": getattr(d, "code", ""),
                "market": "TW",
                "currency": "TWD",
                "amount": getattr(d, "amount", 0),
                "shares": getattr(d, "quantity", None),
                "payDate": datetime.now(timezone.utc).astimezone().isoformat(),
                "externalId": str(getattr(d, "seqno", "") or f"{getattr(d, 'code', '')}-div"),
            }
        )
    return dividends


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不連線 shioaji/Firestore，只印出範例資料")
    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps(generate_dry_run_trades(), ensure_ascii=False, indent=2))
        return

    import shioaji as sj  # dry-run 模式不需要安裝 shioaji/firebase-admin，延遲到這裡才 import

    from firestore_client import init_firestore, set_sync_meta, upsert_dividend, upsert_trade

    api_key = os.environ.get("SHIOAJI_API_KEY")
    api_secret = os.environ.get("SHIOAJI_API_SECRET")
    if not api_key or not api_secret:
        raise RuntimeError("缺少 SHIOAJI_API_KEY / SHIOAJI_API_SECRET 環境變數")

    db = init_firestore()
    api = sj.Shioaji()
    try:
        api.login(api_key=api_key, secret_key=api_secret)

        trades = fetch_trades(api, sj)
        for trade in trades:
            upsert_trade(db, trade)

        # 庫存 (positions) 依 SCHEMA.md 設計不落地寫回 Firestore（App 端用 trades 即時算），
        # 這裡只取出來做換算單位的參考/除錯用途，不寫入。
        try:
            positions = api.list_positions(api.stock_account)
            print(f"[shioaji_sync] 目前庫存共 {len(positions)} 檔（僅供除錯參考，不寫入 Firestore）")
        except Exception as e:
            print(f"[shioaji_sync] 庫存查詢失敗（不影響同步結果）: {e}", file=sys.stderr)

        dividends = fetch_dividends(api)
        for dividend in dividends:
            upsert_dividend(db, dividend)

        set_sync_meta(db, BROKER, True, None)
        print(f"[shioaji_sync] 同步完成，共 {len(trades)} 筆交易、{len(dividends)} 筆股利")
    except Exception as e:
        set_sync_meta(db, BROKER, False, str(e))
        raise
    finally:
        try:
            api.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
