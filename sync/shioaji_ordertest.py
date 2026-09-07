"""永豐 Shioaji 強制「下單測試」用的一次性腳本（模擬環境）。

永豐要求新用戶在模擬模式完成「登入測試 + 下單測試」產出測試報告，才會開放正式環境。
這支腳本只做那件事。跑完到簽署中心確認測試狀態，約 5 分鐘審核。
參考：https://sinotrade.github.io/zh/tutor/prepare/terms/

用法：
    python sync/shioaji_ordertest.py --api-key "你的KEY" --api-secret "你的SECRET"

安全設計（刻意如此，不要改）：
- simulation=True 寫死，沒有切換成正式環境的參數，所以不可能誤送真單
- 委託價刻意設在遠低於市價的位置，就算環境判斷出錯也不會成交
- 送出前需要手動輸入 yes 確認
"""
import argparse

import shioaji as sj

SYMBOL = "2890"  # 永豐金，低價股，測試用
LIMIT_PRICE = 10.0  # 遠低於市價的限價，避免任何情況下成交
QUANTITY = 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--api-secret", required=True)
    args = parser.parse_args()

    print(f"shioaji {sj.__version__}")
    print("模式：模擬環境 simulation=True（此腳本無法切換到正式環境）")

    api = sj.Shioaji(simulation=True)
    accounts = api.login(api_key=args.api_key, secret_key=args.api_secret)
    print("\n登入成功，帳號清單：")
    for acc in accounts:
        print(f"  - {acc}")

    if api.stock_account is None:
        raise SystemExit("拿不到證券帳戶，金鑰可能缺少權限，請檢查 API 管理頁面的權限勾選")

    contract = api.Contracts.Stocks[SYMBOL]
    print(f"\n準備送出模擬委託：{SYMBOL} 買進 {QUANTITY} 股，限價 {LIMIT_PRICE}")
    if input("確認送出？輸入 yes 繼續：").strip().lower() != "yes":
        print("已取消，沒有送出任何委託")
        api.logout()
        return

    order = api.Order(
        price=LIMIT_PRICE,
        quantity=QUANTITY,
        action=sj.constant.Action.Buy,
        price_type=sj.constant.StockPriceType.LMT,
        order_type=sj.constant.OrderType.ROD,
        account=api.stock_account,
    )
    trade = api.place_order(contract, order)

    print("\n=== 委託回傳 ===")
    print(trade)

    api.update_status(api.stock_account)
    print("\n=== 更新後狀態 ===")
    for t in api.list_trades():
        print(f"  - {t}")

    print("\n下單測試完成。到簽署中心確認測試狀態（約 5 分鐘審核）：")
    print("https://www.sinotrade.com.tw/newweb/signCenter/signCenterIndex/")

    api.logout()


if __name__ == "__main__":
    main()
