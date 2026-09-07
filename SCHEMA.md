# Firestore 資料結構（PWA 與 Python 同步腳本共用，不可各自發明欄位）

collection 名稱與欄位皆固定如下，改動前先更新本檔案。

## 為什麼有兩套資料來源

永豐 Shioaji **沒有**「原始每筆買賣」的 API。實測結論（見 `sync/shioaji_selftest.py`）：

- `list_trades()` 只回傳「透過 API 連線下的單」，在 App/網頁手動下的成交它看不到，永遠是 0 筆
- 能拿到的是券商**已經算好的結果**：`list_positions()`（庫存與均價）、`list_profit_loss()`（每次平倉的已實現損益）

所以資料分兩條路，前端讀取後正規化成同一種形狀再合併顯示：

| 來源 | collection | 誰算的 |
|---|---|---|
| 永豐同步 | `positions`、`realized` | 券商算好，直接存 |
| 手動輸入（美股等） | `trades` | 前端用移動平均法自己算 |

---

## collection: `positions`
永豐目前庫存。document ID = `sinopac_{code}_{cond}`。

**每次同步要刪掉不存在的舊 doc**（賣光的部位必須消失），不能只 upsert。

| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | `"sinopac"` |
| symbol | string | 股票代號，如 `"0050"` |
| market | string | `"TW"` |
| currency | string | `"TWD"` |
| lots | number | 張數（`list_positions.quantity`）。**零股會是 0**，不代表沒有股票 |
| avgPrice | number | 每股平均成本（`price`） |
| lastPrice | number | 每股現價（`last_price`） |
| totalCost | number | 總成本 = `list_position_detail[].price` 之和（每筆是該批的**總額**不是單價） |
| marketValue | number | 市值 = `totalCost + unrealizedPnl` |
| unrealizedPnl | number | 未實現損益（`pnl`，已含配息） |
| exDividends | number | 累計配息金額 = `list_position_detail[].ex_dividends` 之和 |
| earliestEntryDate | string | 最早一批的買進日 `YYYY-MM-DD` = `min(list_position_detail[].date)` |
| cond | string | `"Cash"` / `"MarginTrading"` / `"ShortSelling"` |
| syncedAt | string | ISO8601 |

> 不要用 `lots × 1000` 去回推股數：零股的 `lots` 是 0。金額一律用 `totalCost` / `marketValue`，
> 需要股數時用 `totalCost / avgPrice`。

## collection: `realized`
永豐每一次平倉的已實現損益。document ID = `sinopac_{sellDate}_{dseq}`（`dseq` 實測唯一，加日期防跨年重複）。

歷史紀錄只增不刪，不需要清理。

| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | `"sinopac"` |
| symbol | string | |
| market | string | `"TW"` |
| currency | string | `"TWD"` |
| sellDate | string | 平倉日 `YYYY-MM-DD`（`list_profit_loss.date`） |
| lots | number | 張數（零股為 0，同上） |
| sellPrice | number | 每股賣出價（`price`） |
| pnl | number | 已實現損益。**已扣手續費與稅，而且已經含配息**，見下方說明 |
| prRatio | number | 報酬率（`pr_ratio`）。原樣存。單位不明（可能是 % 也可能是小數），未經驗證前不要拿來運算或顯示 |
| entryCost | number | 進場總成本 = `list_profit_loss_detail[].cost` 之和。已用正式環境資料比對確認**等於 `buy_cost`（已扣配息、已含買進手續費）**，不是 `entry_cost` 毛額。例：0050 為 37939 而非 39300 |
| fee | number | `list_profit_loss_detail[].fee` 之和 |
| tax | number | `list_profit_loss_detail[].tax` 之和 |
| exDividendAmt | number | 持有期間配息 = `list_profit_loss_detail[].ex_dividend_amt` 之和。**只作獨立顯示，絕對不要加進 `pnl`** |

### `pnl` 已含配息（重要，別重複計算）

拿 `list_profit_loss_summary` 的實測數字驗證過，公式是：

```
buy_cost  = entry_cost + 買進手續費 − 期間配息
sell_cost = cover_cost − 賣出手續費 − 交易稅
pnl       = sell_cost − buy_cost
```

實測對照（五檔全部完全吻合）：

| 代號 | entry_cost | buy_cost | sell_cost | sell−buy | pnl |
|---|---|---|---|---|---|
| 0050 | 39300 | 37939 | 88436 | 50497 | 50497 |
| 0056 | 230197 | 142305 | 274452 | 132147 | 132147 |
| 00891 | 40050 | 24204 | 91249 | 67045 | 67045 |
| 2330 | 34450 | 32499 | 109863 | 77364 | 77364 |
| 00893 | 46060 | 46082 | 118174 | 72092 | 72092 |

0056 的 `buy_cost` 比 `entry_cost` 低 8.8 萬，就是配息抵減成本的結果；00893 沒配息，`buy_cost` 反而比 `entry_cost` 高 22 元（買進手續費）。

所以配息**已經反映在 `pnl` 裡**。前端把 `exDividendAmt` 當補充資訊單獨顯示，不加總、不列入年度股利。
| entryDate | string? | 加權平均進場日 `YYYY-MM-DD`，用 `cost` 對 `list_profit_loss_detail[].date` 加權 |
| holdingDays | number? | `sellDate - entryDate`。算不出 entryDate 時兩者都留空，**不要填假值** |
| dseq | string | 券商交易序號 |
| syncedAt | string | ISO8601 |

## collection: `trades`
手動輸入的買賣紀錄（美股等永豐同步不到的部分）。document ID = `{broker}_{externalId}`。

前端用**移動平均法**從這裡算出部位與已實現損益，再和 `positions` / `realized` 合併。

| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | `"manual"` \| `"schwab"` |
| symbol | string | 台股純數字如 `"2330"`，美股 ticker 如 `"AAPL"` |
| market | string | `"TW"` \| `"US"` |
| side | string | `"buy"` \| `"sell"` |
| quantity | number | **股數**（不是張數） |
| price | number | 每股成交價 |
| fee | number | 手續費 |
| tax | number | 交易稅 |
| currency | string | `"TWD"` \| `"USD"` |
| tradeDate | string | ISO8601 |
| externalId | string | 防重複用 |
| note | string? | 使用者筆記，同步腳本一律不可覆寫此欄位 |
| syncedAt | string | ISO8601 |

## collection: `quotes`
現價。document ID = `{market}:{symbol}`，例如 `TW:2330`。

永豐同步時會自動從 `list_positions.last_price` 寫入，**使用者不需要手動填**。
手動輸入的美股部位沒有自動來源，PWA 允許手填（沒有免費且允許瀏覽器直連的行情 API）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| symbol | string | |
| market | string | |
| price | number | 每股現價 |
| source | string | `"sinopac"` \| `"manual"` |
| updatedAt | string | ISO8601 |

## collection: `dividends`
手動輸入的股利紀錄。永豐**沒有**股利查詢 API，台股的配息改用 `positions.exDividends`
與 `realized.exDividendAmt`（累計金額，沒有發放日期）呈現。

| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | |
| symbol | string | |
| market | string | |
| currency | string | |
| amount | number | 實收金額 |
| shares | number? | |
| payDate | string | ISO8601 |
| externalId | string | |
| syncedAt | string | |

## collection: `calendarEvents`
| 欄位 | 型別 | 說明 |
|---|---|---|
| symbol | string | |
| market | string | |
| type | string | `"exDividend"` \| `"earnings"` |
| eventDate | string | `YYYY-MM-DD`。**寫入前一定要正規化**：TWSE 開放資料可能給民國年（`1150915`、`115/09/15`）或 `20260915`，原樣寫進去會讓前端解析與提醒信的字串範圍查詢全部失效。`calendar_sync.py` 的 `normalize_date()` 負責轉換，轉不出來就跳過該筆 |
| note | string? | |

## collection: `syncMeta`
document ID = broker 名稱（`"sinopac"` / `"schwab"` / `"calendar"`）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| lastSyncAt | string | ISO8601 |
| lastSuccess | boolean | |
| lastError | string? | |

---

## 前端計算（不落地）

- **手動交易的部位與已實現損益**：用移動平均法從 `trades` 即時算，不寫回 Firestore
- **勝率 / 盈虧比**：`realized` 加上手動交易算出的平倉紀錄，一起統計
- **平均持有天數**：只採計有 `holdingDays` 的 `realized` 紀錄與手動交易，算不出來的不列入分母
- **曝險比例**：`positions.marketValue` 加上手動部位的市值，**不同幣別不換算匯率**，分開檢視

## 認證

- Python 端：Firebase Admin SDK + 服務帳戶（`FIREBASE_SERVICE_ACCOUNT`，接受 base64 或原始 JSON），完全繞過 Security Rules
- PWA 端：Firebase Auth Email/Password，只有一個帳號。PWA 在公開網址上，匿名登入等於門戶大開，所以 `firestore.rules` 把讀寫綁死在那一個 UID（`OWNER_UID`）
