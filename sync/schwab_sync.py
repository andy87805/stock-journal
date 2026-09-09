"""
從 Charles Schwab 官方 Trader API 拉交易/股利紀錄，寫入 Firestore。
環境變數：SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, SCHWAB_REFRESH_TOKEN

**重要**：Schwab 的 refresh_token 效期只有 7 天，目前官方沒有提供全自動、免人工介入的更新流程。
如果下面 refresh_access_token() 失敗（代表 refresh_token 已過期或被撤銷），例外會直接往外拋出，
不會被吞掉——讓這支腳本以非 0 結束碼結束，GitHub Actions job 會顯示失敗，
GitHub 會自動寄失敗通知信給使用者。屆時需要重新手動跑一次 schwab_auth.py 取得新的
refresh_token，再更新 GitHub Secret。
"""
import argparse
import json
import os
from datetime import datetime, timedelta, timezone

import requests

BROKER = "schwab"
TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token"
API_BASE = "https://api.schwabapi.com/trader/v1"


def generate_dry_run_trades():
    now = datetime.now(timezone.utc).isoformat()
    return [
        {
            "broker": BROKER,
            "symbol": "AAPL",
            "market": "US",
            "side": "buy",
            "quantity": 10,
            "price": 225.5,
            "fee": 0,
            "tax": 0,
            "currency": "USD",
            "tradeDate": now,
            "externalId": "DRYRUN-SCHWAB-0001",
        },
        {
            "broker": BROKER,
            "symbol": "VOO",
            "market": "US",
            "side": "sell",
            "quantity": 3,
            "price": 512.75,
            "fee": 0,
            "tax": 0,
            "currency": "USD",
            "tradeDate": now,
            "externalId": "DRYRUN-SCHWAB-0002",
        },
    ]


def generate_dry_run_dividends():
    now = datetime.now(timezone.utc).isoformat()
    return [
        {
            "broker": BROKER,
            "symbol": "AAPL",
            "market": "US",
            "currency": "USD",
            "amount": 4.8,
            "shares": 10,
            "payDate": now,
            "externalId": "DRYRUN-SCHWAB-DIV-0001",
        },
    ]


def refresh_access_token(client_id, client_secret, refresh_token):
    resp = requests.post(
        TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        auth=(client_id, client_secret),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def get_account_hash(access_token):
    resp = requests.get(
        f"{API_BASE}/accounts/accountNumbers",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    accounts = resp.json()
    if not accounts:
        raise RuntimeError("Schwab 帳戶清單為空，無法取得 accountNumber/hash")
    # 假設只有單一帳戶（個人專案），多帳戶情境需自行擴充選擇邏輯。
    return accounts[0]["hashValue"]


def fetch_transactions(access_token, account_hash):
    """對照 Schwab Trader API 文件：GET /accounts/{accountHash}/transactions，用 startDate/endDate
    篩選近期交易。回傳的每筆 transaction 依官方文件有 type（如 TRADE / DIVIDEND_OR_INTEREST 等）
    與 transferItems 明細，實際欄位名稱請對照 https://developer.schwab.com/ 最新文件核對。
    """
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=7)
    resp = requests.get(
        f"{API_BASE}/accounts/{account_hash}/transactions",
        headers={"Authorization": f"Bearer {access_token}"},
        params={
            "startDate": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "endDate": end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def map_transactions(raw_transactions):
    trades = []
    dividends = []
    for tx in raw_transactions:
        tx_type = tx.get("type", "")
        tx_id = str(tx.get("activityId") or tx.get("transactionId") or "")
        trade_date = tx.get("tradeDate") or tx.get("time") or datetime.now(timezone.utc).isoformat()

        if tx_type == "TRADE":
            for item in tx.get("transferItems", []):
                instrument = item.get("instrument", {}) or {}
                symbol = instrument.get("symbol")
                if not symbol:
                    continue
                amount = item.get("amount", 0)
                fees = tx.get("fees", {})
                commission = fees.get("commission", 0) if isinstance(fees, dict) else 0
                trades.append(
                    {
                        "broker": BROKER,
                        "symbol": symbol,
                        "market": "US",
                        "side": "buy" if amount > 0 else "sell",
                        "quantity": abs(amount),
                        "price": item.get("price", 0),
                        "fee": commission or 0,
                        "tax": 0,
                        "currency": "USD",
                        "tradeDate": trade_date,
                        "externalId": tx_id,
                    }
                )
        elif tx_type in ("DIVIDEND_OR_INTEREST", "CASH_RECEIPT"):
            for item in tx.get("transferItems", []):
                instrument = item.get("instrument", {}) or {}
                symbol = instrument.get("symbol")
                if not symbol:
                    continue
                dividends.append(
                    {
                        "broker": BROKER,
                        "symbol": symbol,
                        "market": "US",
                        "currency": "USD",
                        "amount": abs(item.get("amount", 0)),
                        "shares": None,
                        "payDate": trade_date,
                        "externalId": tx_id,
                    }
                )
    return trades, dividends


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不連線 Schwab/Firestore，只印出範例資料")
    args = parser.parse_args()

    if args.dry_run:
        print(
            json.dumps(
                {"trades": generate_dry_run_trades(), "dividends": generate_dry_run_dividends()},
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    from firestore_client import init_firestore, set_sync_meta, upsert_dividend, upsert_trade, user_root

    client_id = os.environ.get("SCHWAB_CLIENT_ID")
    client_secret = os.environ.get("SCHWAB_CLIENT_SECRET")
    refresh_token = os.environ.get("SCHWAB_REFRESH_TOKEN")
    if not client_id or not client_secret or not refresh_token:
        raise RuntimeError("缺少 SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET / SCHWAB_REFRESH_TOKEN 環境變數")

    db = init_firestore()
    root = user_root(db)
    try:
        access_token = refresh_access_token(client_id, client_secret, refresh_token)
        account_hash = get_account_hash(access_token)
        raw_transactions = fetch_transactions(access_token, account_hash)
        trades, dividends = map_transactions(raw_transactions)

        for trade in trades:
            upsert_trade(root, trade)
        for dividend in dividends:
            upsert_dividend(root, dividend)

        set_sync_meta(root, BROKER, True, None)
        print(f"[schwab_sync] 同步完成，共 {len(trades)} 筆交易、{len(dividends)} 筆股利")
    except Exception as e:
        set_sync_meta(root, BROKER, False, str(e))
        raise


if __name__ == "__main__":
    main()
