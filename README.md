# stock-journal

個人股票交易日誌。券商資料自動同步到 Firestore，PWA 讀取顯示庫存、損益、除權息/財報行事曆。

**線上網址：https://andy87805.github.io/stock-journal/**（iPhone 用 Safari 開 → 分享 → 加入主畫面）

## 架構

```
永豐證券 (Shioaji) ─┐
Schwab（暫緩）      ├─→ Python 同步腳本 (sync/, GitHub Actions cron) ─→ Firestore
Finnhub (行事曆)   ─┘                                                     │
                                                                          │ Firebase Auth Email/Password（單一帳號）
                                                                          ▼
                                                       PWA (web/, GitHub Pages)
                                                       庫存/損益/成本均價即時計算，不落地
```

- 資料結構定義：[SCHEMA.md](SCHEMA.md)
- 設定手續：[SETUP.md](SETUP.md)
- 同步腳本各自獨立、互不阻擋：`sync/shioaji_sync.py`、`sync/schwab_sync.py`、`sync/calendar_sync.py`，另外 `sync/send_reminders.py` 每天寄一封近期除權息/財報提醒信
- **為什麼是 PWA 不是原生 iOS App**：免費 Apple ID 簽出來的 App 每 7 天就過期要重簽重裝，不能接受。PWA 加到主畫面沒有效期、不用 Mac、一樣免費
- Schwab 美股同步暫緩：Schwab 開發者帳號 2FA 只收美國門號，取得前 `schwab_sync.py` 會失敗，屬預期狀態

## 狀態

個人專案、免費額度取向，未做多使用者/正式產品等級的安全與可靠性強化。
