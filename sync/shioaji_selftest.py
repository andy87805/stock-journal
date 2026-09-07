"""永豐 Shioaji 唯讀自我檢測：確認登入、權限、以及各個帳務 API 實際回傳什麼。

這支腳本**不會下單、不會改單、不寫入 Firestore**，純粹讀取並印出結果。
用途有兩個：
1. 申請權限後確認金鑰真的可用（signed 狀態、正式環境權限）
2. 確認 shioaji_sync.py 該用哪個 API——list_trades() 可能只回傳「透過 API 連線下的單」，
   抓不到在永豐 App/網頁手動下的歷史成交，那種要用 list_profit_loss()

用法（PowerShell，金鑰從環境變數或參數帶入）：
    python sync/shioaji_selftest.py --api-key "你的KEY" --api-secret "你的SECRET"
    python sync/shioaji_selftest.py --api-key ... --api-secret ... --production

預設跑模擬模式（simulation=True）。要看真實帳務資料才加 --production。

強制的「下單測試」不在這支腳本裡，那一步請自己執行，見：
https://sinotrade.github.io/zh/tutor/prepare/terms/
"""
import argparse
import os
from datetime import date, timedelta

import shioaji as sj


def show(label, fn):
    """呼叫一個帳務 API 並印出實際回傳的型別/筆數/欄位。

    每個呼叫都獨立 try/except：這些 API 的簽章沒有 docstring 可查，權限不足或參數
    不符時會直接丟例外，但一個失敗不該中斷其他探測——把每個結果都看到才是重點。
    """
    print(f"\n=== {label} ===")
    try:
        result = fn()
    except Exception as exc:
        print(f"  失敗: {type(exc).__name__}: {exc}")
        return None
    if result is None:
        print("  回傳 None")
        return None
    if isinstance(result, (list, tuple)):
        print(f"  {len(result)} 筆")
        for item in result[:3]:
            print(f"  - {item}")
        if len(result) > 3:
            print(f"  ...（其餘 {len(result) - 3} 筆略）")
    else:
        print(f"  {result}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", default=os.environ.get("SHIOAJI_API_KEY"))
    parser.add_argument("--api-secret", default=os.environ.get("SHIOAJI_API_SECRET"))
    parser.add_argument(
        "--production",
        action="store_true",
        help="連正式環境（預設模擬環境）。要看真實庫存與已實現損益才需要。",
    )
    parser.add_argument("--days", type=int, default=365, help="已實現損益往回查幾天，預設 365")
    args = parser.parse_args()

    if not args.api_key or not args.api_secret:
        raise SystemExit("需要 SHIOAJI_API_KEY / SHIOAJI_API_SECRET（環境變數或 --api-key/--api-secret）")

    mode = "正式環境 (production)" if args.production else "模擬環境 (simulation)"
    print(f"shioaji {sj.__version__}｜{mode}")

    api = sj.Shioaji(simulation=not args.production)
    accounts = api.login(api_key=args.api_key, secret_key=args.api_secret)

    print("\n=== 登入成功，帳號清單 ===")
    for acc in accounts:
        # signed=True 表示該帳戶已完成簽署與測試，可用正式環境
        print(f"  - {acc}")

    stock_account = getattr(api, "stock_account", None)
    print(f"\n證券帳戶: {stock_account}")
    if stock_account is None:
        print("拿不到 stock_account，後面的帳務查詢無法進行（可能是金鑰缺少『帳務』權限）")
        api.logout()
        return

    end = date.today()
    begin = end - timedelta(days=args.days)

    show("list_positions（目前庫存與成本）", lambda: api.list_positions(stock_account))
    show(
        f"list_profit_loss（已實現損益 {begin} ~ {end}）",
        lambda: api.list_profit_loss(stock_account, begin.isoformat(), end.isoformat()),
    )
    show("list_settlements（交割金額）", lambda: api.list_settlements(stock_account))

    # list_trades 前要先 update_status，否則通常是空的
    show("update_status", lambda: api.update_status(stock_account))
    trades = show("list_trades（注意：可能只有本次 API 連線下的單）", lambda: api.list_trades())

    print("\n--- 判讀重點 ---")
    if trades is not None and len(trades) == 0:
        print("list_trades 是空的。如果你平常是用永豐 App/網頁手動下單，這就印證了它抓不到")
        print("歷史成交，shioaji_sync.py 必須改用 list_profit_loss + list_positions。")
    print("把以上輸出貼回來，我依實際回傳的欄位改寫 shioaji_sync.py。")

    api.logout()


if __name__ == "__main__":
    main()
