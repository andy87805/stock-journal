"""永豐 Shioaji 唯讀自我檢測：確認登入、權限、以及各個帳務 API 實際回傳什麼。

這支腳本**不會下單、不會改單、不寫入 Firestore**，純粹讀取並印出結果。
用途有兩個：
1. 申請權限後確認金鑰真的可用（signed 狀態、正式環境權限）
2. 確認 shioaji_sync.py 該用哪個 API。已實測結論：list_trades() 只回傳「透過 API 連線下的
   單」，抓不到在永豐 App/網頁手動下的成交（會是 0 筆），要用 list_positions() 與
   list_profit_loss()。update_status() 需要「交易」權限，唯讀金鑰會拿到 401，屬預期。

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


def dump_fields(obj, indent="      "):
    """印出物件的完整欄位。

    這些回傳物件的 repr 是簡寫的（例如 StockPosition 只顯示 5 個欄位），
    但實際欄位更多，而要照著改寫同步腳本就得看到全部。
    """
    for attr in ("model_dump", "dict", "_asdict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                for k, v in fn().items():
                    print(f"{indent}{k} = {v!r}")
                return
            except Exception:
                pass
    data = getattr(obj, "__dict__", None)
    if data:
        for k, v in data.items():
            print(f"{indent}{k} = {v!r}")
    else:
        print(f"{indent}{obj!r}")


def show(label, fn, dump_first=True):
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
        if dump_first and result:
            print(f"    第一筆的完整欄位（{type(result[0]).__name__}）:")
            dump_fields(result[0])
    else:
        print(f"  {result}")
        if dump_first:
            print(f"    完整欄位（{type(result).__name__}）:")
            dump_fields(result)
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

    positions = show("list_positions（目前庫存與成本）", lambda: api.list_positions(stock_account))
    pnls = show(
        f"list_profit_loss（已實現損益 {begin} ~ {end}）",
        lambda: api.list_profit_loss(stock_account, begin.isoformat(), end.isoformat()),
    )
    show("list_settlements（交割金額）", lambda: api.list_settlements(stock_account))

    # 兩個 detail API 都是用 id 對應。如果所有紀錄的 id 都是 0，就只拿得到第一筆的明細，
    # 那「平均持有天數」（需要進場日）和「股利」（需要 ex_dividends）都做不出來。
    if positions:
        print("\n=== list_positions 每筆的 id（判斷能不能逐檔抓明細）===")
        for p in positions:
            print(
                f"  id={getattr(p, 'id', None)!r} "
                f"code={getattr(p, 'code', None)!r} "
                f"quantity={getattr(p, 'quantity', None)!r}"
            )
        # 用最後一檔的 id 再試一次：如果回傳的 code 不是那一檔，就代表 id 沒有真的在選資料
        last_pos = positions[-1]
        detail = show(
            f"list_position_detail 用最後一檔 {getattr(last_pos, 'code', '?')} 的 "
            f"id={getattr(last_pos, 'id', None)!r} 再查一次",
            lambda: api.list_position_detail(stock_account, getattr(last_pos, "id", 0)),
            dump_first=False,
        )
        if detail:
            codes = {getattr(d, "code", None) for d in detail}
            expected = getattr(last_pos, "code", None)
            print(f"  回傳的 code 集合: {codes}｜預期: {expected!r}")
            print(
                "  → id 有效，可逐檔查明細"
                if codes == {expected}
                else "  → id 無效（拿到的不是指定那一檔），逐檔明細做不到"
            )

    if pnls:
        print("\n=== list_profit_loss 每筆的對應鍵（判斷能不能逐筆抓進場日）===")
        for p in pnls:
            print(
                f"  id={getattr(p, 'id', None)!r} "
                f"code={getattr(p, 'code', None)!r} "
                f"date={getattr(p, 'date', None)!r} "
                f"quantity={getattr(p, 'quantity', None)!r} "
                f"dseq={getattr(p, 'dseq', None)!r} "
                f"seqno={getattr(p, 'seqno', None)!r}"
            )

    # 這兩個 detail API 決定我們能不能還原到「每一筆買賣」的粒度：
    # 有進出場日期與單價才能算持有天數，也才有辦法保留交易級別的紀錄。
    if positions:
        first = positions[0]
        show(
            f"list_position_detail（{getattr(first, 'code', '?')} 的分筆庫存明細）",
            lambda: api.list_position_detail(stock_account, getattr(first, "id", 0)),
        )
    if pnls:
        first_pnl = pnls[0]
        show(
            f"list_profit_loss_detail（{getattr(first_pnl, 'code', '?')} 的損益明細）",
            lambda: api.list_profit_loss_detail(stock_account, getattr(first_pnl, "id", 0)),
        )
    show(
        f"list_profit_loss_summary（{begin} ~ {end} 彙總）",
        lambda: api.list_profit_loss_summary(stock_account, begin.isoformat(), end.isoformat()),
    )

    print("\n--- 判讀重點 ---")
    print("重點看 list_position_detail / list_profit_loss_detail 有沒有進出場日期與單價。")
    print("把以上輸出貼回來，我依實際回傳的欄位改寫 shioaji_sync.py。")

    # logout 失敗只是連線收尾的問題，不影響上面已經取得的資料
    try:
        api.logout()
    except Exception as exc:
        print(f"\n(logout 收尾失敗，可忽略: {type(exc).__name__})")


if __name__ == "__main__":
    main()
