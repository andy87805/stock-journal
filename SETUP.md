# 一次性設定手續

照順序做一次即可，之後全自動。標「不確定」的地方代表官方介面可能已經改版，實際操作以當下畫面為準。

---

## 1. 建立 GitHub public repo

必須是 **public**：`build-ios.yml` 跑在 `macos-latest`，macOS runner 只有 public repo 才免費無限額度，private repo 會依分鐘數計費（且費率是 Linux 的好幾倍）。這個 repo 只放程式碼跟 workflow，不會有機密內容（金鑰都走 Secrets），public 沒問題。

```powershell
cd "C:\Users\andy8\OneDrive\桌面\Claude\stock-journal"
git init
git add .
git commit -m "init"
gh repo create stock-journal --public --source=. --remote=origin
git push -u origin main
```

（沒裝 `gh` CLI 就手動在 github.com 建立 public repo 叫 `stock-journal`，再 `git remote add origin https://github.com/<你的帳號>/stock-journal.git`。）

---

## 2. Firebase 專案

1. 開 https://console.firebase.google.com，建立新專案。
2. **Firestore Database** → 建立資料庫 → 選 **production mode**（不是 test mode）。
3. **Authentication** → Sign-in method → 啟用 **Anonymous**。
4. 專案設定 → **服務帳戶 (Service accounts)** → 產生新的私密金鑰，下載 JSON。
   這個 JSON **整包內容**（原始文字，不用轉碼）存進 GitHub Secret `FIREBASE_SERVICE_ACCOUNT`。
5. 專案設定 → 一般 → 你的應用程式 → 新增 iOS App，bundle ID 填
   `com.andy878005.stockjournal`（要跟 `ios/project.yml` 裡的
   `PRODUCT_BUNDLE_IDENTIFIER` 一致）。下載 `GoogleService-Info.plist`。
6. 這個 plist 要先轉成 base64 才能塞進 GitHub Secret（Secret 是純文字欄位）：

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\GoogleService-Info.plist")) | Set-Clipboard
   ```

   這行直接把 base64 結果複製到剪貼簿，貼進 GitHub Secret `GOOGLE_SERVICE_INFO_PLIST` 即可。

7. 部署 `firestore.rules`（需要 Firebase CLI）：

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add   # 選你剛建立的專案
   firebase deploy --only firestore:rules
   ```

---

## 3. 永豐證券（Shioaji）API Key

不確定：永豐官網/App 內申請 API Key 的選單路徑近期可能調整。目前流程大致是：**永豐金證券 App 或官網 → 憑證/電子交易相關選單 → 申請 API 服務**。若照這個路徑找不到，搜尋「永豐 API 申請」或「shioaji 申請」確認當下最新流程。

申請下來後把 API Key / Secret 存成：

- `SHIOAJI_API_KEY`
- `SHIOAJI_API_SECRET`

---

## 4. Schwab 開發者帳號

1. 到 https://developer.schwab.com 註冊開發者帳號。
2. 建立一個 App，Redirect/Callback URI 填 `http://localhost:8182`（`sync/schwab_auth.py` 目前寫死監聽這個 URI，是 plain http，不是 https）。

   如果 Schwab Developer Portal 當下畫面強制要求 https 才能建立 App，代表這個腳本要跟著改，屆時請對照 Portal 當下的實際要求調整 `sync/schwab_auth.py` 裡的 `REDIRECT_URI`，這裡不確定 Schwab 政策是否會變動。

3. 拿到 Client ID / Secret，存成：
   - `SCHWAB_CLIENT_ID`
   - `SCHWAB_CLIENT_SECRET`

4. 在本機（能開瀏覽器完成 OAuth 的機器）跑：

   ```powershell
   python sync/schwab_auth.py
   ```

   跑完會拿到第一組 `refresh_token`，存成 `SCHWAB_REFRESH_TOKEN`。

   **注意，這點很重要**：`sync/schwab_auth.py` 的註解寫明 Schwab 的 refresh_token **效期只有 7 天**。過期後 `schwab_sync.py` 會開始失敗（`sync-data.yml` 執行紀錄會看到 Schwab 那一步紅字）。屆時必須回到本機重跑一次 `python sync/schwab_auth.py`，把新印出的 `refresh_token` 更新到 GitHub Secret `SCHWAB_REFRESH_TOKEN`。這不是一次性設定，是要每週左右手動做一次的固定作業——如果覺得麻煩，之後可以考慮另外寫一支自動 refresh 的腳本，但目前 `schwab_sync.py` 沒有做這件事。

---

## 5. Finnhub API Key

https://finnhub.io 免費註冊，拿 API key，存成 `FINNHUB_API_KEY`。

---

## 6. Gmail App Password

沿用（或新建）一組 Gmail 帳號的 **App Password**（不是登入密碼，Google 帳戶設定 → 安全性 → 兩步驟驗證 → 應用程式密碼）。存成：

- `SENDER_EMAIL`
- `GMAIL_APP_PASSWORD`
- `RECIPIENT_EMAIL`

跟 `stock-news-mailer` 專案共用同一組帳號也可以。

---

## 7. Mac 一次性設定（build-ios.yml 需要的簽章材料）

需要一台 Mac（借用也行，這步做完之後就不再需要）：

1. 安裝 Xcode（App Store）+ Command Line Tools。
2. 用免費 Apple ID 登入 Xcode（Xcode → Settings → Accounts）。
3. 把要裝這個 App 的 iPhone 接上 Mac，開 Xcode 的 **Window → Devices and Simulators**，選到該裝置，複製 **Identifier**（UDID）。存成 `DEVICE_UDID`。
4. 安裝 fastlane：

   ```bash
   gem install fastlane
   ```

5. 產生免互動登入用的 session（避免 CI 上要手動輸入 Apple ID + 2FA）：

   ```bash
   fastlane spaceauth -u <你的 Apple ID>
   ```

   輸入密碼、完成 2FA 後，終端機會印出一長串文字（`FASTLANE_SESSION` 的值），把**整段**存成 GitHub Secret `FASTLANE_SESSION`。同時把登入用的 Apple ID 存成 `APPLE_ID`。

   這組 session 效期不確定（Apple 沒公開明確天數，經驗上抓數週到數月不等，且 Apple 端政策可能隨時改變導致提前失效）。**過期徵兆**：`build-ios.yml` 執行失敗，log 會在 `cert`/`sigh` 步驟附近出現登入或認證相關錯誤。屆時回到這台 Mac 重新跑一次 `fastlane spaceauth -u <apple id>`，用新印出的內容更新 `FASTLANE_SESSION` 這個 Secret 即可，不用重新設定其他東西。

---

## 8. 把所有值加進 GitHub Secrets

Repo 頁面 → **Settings → Secrets and variables → Actions → New repository secret**，逐一加入以下全部（共 14 個，方便核對）：

| Secret | 來源 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 步驟 2 |
| `GOOGLE_SERVICE_INFO_PLIST` | 步驟 2（base64） |
| `SHIOAJI_API_KEY` | 步驟 3 |
| `SHIOAJI_API_SECRET` | 步驟 3 |
| `SCHWAB_CLIENT_ID` | 步驟 4 |
| `SCHWAB_CLIENT_SECRET` | 步驟 4 |
| `SCHWAB_REFRESH_TOKEN` | 步驟 4 |
| `FINNHUB_API_KEY` | 步驟 5 |
| `SENDER_EMAIL` | 步驟 6 |
| `GMAIL_APP_PASSWORD` | 步驟 6 |
| `RECIPIENT_EMAIL` | 步驟 6 |
| `APPLE_ID` | 步驟 7 |
| `DEVICE_UDID` | 步驟 7 |
| `FASTLANE_SESSION` | 步驟 7 |

---

## 9. 第一次手動觸發驗證

1. Repo 頁面 → **Actions** 分頁。
2. 選 **Sync Trading Data** → **Run workflow** → 手動觸發，確認三支同步腳本都成功（或至少不是因為設定錯誤而失敗）。
3. 選 **Build & Publish iOS OTA Install** → **Run workflow**，等它跑完（含 macOS build，會比較久）。
4. 跑完後檢查 `gh-pages` branch 有沒有產生 `manifest.plist` / `index.html` / `*.ipa`，並確認有收到安裝連結信。
5. 手機上用 Mail App 或 Safari 開信，點安裝連結，裝好後到「設定 → 一般 → VPN 與裝置管理」信任開發者憑證，才能打開 App。
