# stock-journal

個人股票交易日誌。券商資料自動同步到 Firestore，iOS App 讀取顯示庫存、損益、除權息/財報行事曆。

## 架構

```
永豐證券 (Shioaji) ─┐
Schwab              ├─→ Python 同步腳本 (sync/, GitHub Actions cron) ─→ Firestore
Finnhub (行事曆)   ─┘                                                     │
                                                                          │ Firebase Auth 匿名登入
                                                                          ▼
                                                              iOS App (SwiftUI, ios/)
                                                              庫存/損益/成本均價即時計算，不落地
```

- 資料結構定義：[SCHEMA.md](SCHEMA.md)
- Python 同步腳本三支，各自獨立、互不阻擋：`sync/shioaji_sync.py`、`sync/schwab_sync.py`、`sync/calendar_sync.py`
- iOS App 用 XcodeGen 產生 Xcode 專案（`ios/project.yml`），不 checked-in `.xcodeproj`
- iOS App 沒有上架 App Store，用 free-tier development signing + OTA (`itms-services://`) 安裝，每週由 GitHub Actions 重新 build 一次並寄安裝連結信
- 一次性設定手續：[SETUP.md](SETUP.md)

## 狀態

個人專案、免費額度取向，未做多使用者/正式產品等級的安全與可靠性強化（見 `firestore.rules` 註解）。
