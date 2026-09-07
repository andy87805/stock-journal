# 設定手續

架構已從原生 iOS App 改成 **PWA + GitHub Pages**（原因：免費 Apple ID 簽的 App 每 7 天過期，要重簽重裝）。
因此 Apple ID、Xcode、fastlane、`spaceauth`、XcodeGen、OTA 安裝連結、`DEVICE_UDID` / `APPLE_ID` / `FASTLANE_SESSION` / `GOOGLE_SERVICE_INFO_PLIST` 這些**全部不再需要**，對應的 GitHub Secrets 可以直接刪掉。

標「不確定」的地方代表官方介面可能已改版，實際以當下畫面為準。

---

## 已完成，不用再做

- GitHub repo `andy87805/stock-journal`（public）
- Firebase 專案 `stock-app-database-3cda4`
- Firestore Database 已建立
- `firestore.rules` 已用 `firebase deploy --only firestore:rules` 部署過一次
- Firebase Web App 已註冊，公開設定已寫進 `web/firebase-config.js`
  （Firebase Web API key 是專案識別碼不是密鑰，可以進 public repo，實際防線是 Firestore Security Rules）
- 以下 GitHub Secrets 已設定：
  `FIREBASE_SERVICE_ACCOUNT`、`SHIOAJI_API_KEY`、`SHIOAJI_API_SECRET`、
  `FINNHUB_API_KEY`、`SENDER_EMAIL`、`GMAIL_APP_PASSWORD`、`RECIPIENT_EMAIL`

---

## 1. Firebase Authentication：建立唯一帳號

PWA 放在公開網址上，所以**不能再用匿名登入**（任何人拿到網址就能讀你的交易資料）。改成 Email/Password，只開一個帳號，Firestore rules 綁死那一個 UID。

1. Firebase Console → 你的專案 → **Authentication** → **Sign-in method**
2. 啟用 **電子郵件/密碼 (Email/Password)** 提供者。（下面的「電子郵件連結（無密碼登入）」不用開。）
3. 同一頁把 **匿名 (Anonymous)** 提供者**停用**——舊架構才需要，現在留著只是多一個洞。
4. 切到 **Users** 分頁 → **Add user**，自己填 email 和密碼（密碼自己決定，不要寫進任何檔案）。
5. 建好後那一列會顯示 **User UID**（一串英數字），複製起來。
6. 把這個 UID 貼進 `firestore.rules` 裡對應的位置，然後重新部署：

   ```powershell
   cd "C:\Users\andy8\OneDrive\桌面\Claude\stock-journal"; firebase deploy --only firestore:rules
   ```

沒改 rules 就直接用的話，登入會成功但讀不到資料（或反過來任何人都讀得到），一定要做這步。

---

## 2. 開啟 GitHub Pages

1. Repo 頁面 → **Settings** → **Pages**
2. **Source** 選 **GitHub Actions**（不是 "Deploy from a branch"）。
3. 回 **Actions** 分頁 → 選 **Deploy PWA to GitHub Pages** → **Run workflow** 手動觸發一次。
4. 跑完後網址是：

   **https://andy87805.github.io/stock-journal/**

之後只要 `web/` 底下有 commit push 到 `main`，就會自動重新部署。

---

## 3. iPhone 安裝到主畫面

**一定要用 Safari**，iOS 只允許從 Safari 加到主畫面，Chrome 沒有這個選項。

1. Safari 開 https://andy87805.github.io/stock-journal/
2. 用步驟 1 建的 email / 密碼登入。
3. 底部**分享**按鈕 → 往下捲 → **加入主畫面**。
4. 之後從主畫面圖示開啟，就是全螢幕、沒有 Safari 網址列的樣子。

改版後如果手機上還是舊畫面，通常是 Service Worker 快取；從主畫面圖示關掉再開，或在 Safari 裡強制重新整理一次。

---

## 4. Schwab（美股）：暫緩

Schwab Developer Portal 的 2FA 只收**美國門號**，目前沒有，所以：

- `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET` / `SCHWAB_REFRESH_TOKEN` **沒有設定**
- `sync-data.yml` 裡的 Schwab 那一步會失敗，這是預期中的，不是壞掉
- 台股（Shioaji）和行事曆同步不受影響，它們各自 `continue-on-error`

拿到美國門號之後再回頭做 `sync/schwab_auth.py` 那套流程（Redirect URI 用 `https://127.0.0.1:8182`，需要先自簽憑證）。另外注意 Schwab 的 refresh token 效期只有 7 天，屆時要考慮這個手動更新成本划不划算。

---

## 5. 目前完整的 GitHub Secrets 清單

Repo → **Settings → Secrets and variables → Actions**。

| Secret | 狀態 | 用途 |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 已設定 | Python 端寫 Firestore（服務帳戶 JSON 原始內容） |
| `SHIOAJI_API_KEY` | 已設定 | 永豐台股同步 |
| `SHIOAJI_API_SECRET` | 已設定 | 同上 |
| `FINNHUB_API_KEY` | 已設定 | 美股財報日 |
| `SENDER_EMAIL` | 已設定 | 提醒信寄件者 |
| `GMAIL_APP_PASSWORD` | 已設定 | Gmail 應用程式密碼（非登入密碼） |
| `RECIPIENT_EMAIL` | 已設定 | 提醒信收件者 |
| `SCHWAB_CLIENT_ID` | 未設定（暫緩） | 等美國門號 |
| `SCHWAB_CLIENT_SECRET` | 未設定（暫緩） | 等美國門號 |
| `SCHWAB_REFRESH_TOKEN` | 未設定（暫緩） | 等美國門號 |

可以刪除的舊 Secret：`GOOGLE_SERVICE_INFO_PLIST`、`APPLE_ID`、`DEVICE_UDID`、`FASTLANE_SESSION`（如果當初有設）。

---

## 6. 驗證

```powershell
cd "C:\Users\andy8\OneDrive\桌面\Claude\stock-journal"; python sync/send_reminders.py --dry-run
```

這行不連網、不需要金鑰，只印出提醒信的範例內容，用來確認格式。

線上驗證：Actions → **Sync Trading Data** → **Run workflow**，看 Shioaji 和 Calendar 兩步是否成功（Schwab 失敗是預期的）。提醒信只在排程的台股那一輪（05:35 UTC）和手動觸發時寄，一天不會寄兩封；近 7 天沒有除權息/財報就不寄信。
