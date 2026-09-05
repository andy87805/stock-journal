# Firestore 資料結構（iOS App 與 Python 同步腳本共用，不可各自發明欄位）

專案 ID／collection 名稱皆固定如下，新增欄位前先更新本檔案。

## collection: `trades`
單筆買賣紀錄。document ID 用 `{broker}_{externalId}`（沒有 externalId 就用 `{broker}_{symbol}_{tradeDate}_{side}_{quantity}` 組字串 hash）確保重複同步時是 upsert 不是重複寫入。

| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | `"sinopac"` \| `"schwab"` |
| symbol | string | 股票代號，台股純數字如 `"2330"`，美股 ticker 如 `"AAPL"` |
| market | string | `"TW"` \| `"US"` |
| side | string | `"buy"` \| `"sell"` |
| quantity | number | 股數（台股一張=1000股，這裡一律存「股數」不是「張數」） |
| price | number | 每股成交價 |
| fee | number | 手續費 |
| tax | number | 交易稅（台股賣出才有，美股通常 0） |
| currency | string | `"TWD"` \| `"USD"` |
| tradeDate | string | ISO8601，如 `"2026-09-05T09:30:00+08:00"` |
| externalId | string | 券商原始成交編號，用於防重複 |
| note | string? | 使用者手動筆記，選填，App 端可編輯，同步腳本不可覆寫此欄位 |
| syncedAt | string | 本次寫入時間 ISO8601 |

## collection: `dividends`
| 欄位 | 型別 | 說明 |
|---|---|---|
| broker | string | 同上 |
| symbol | string | |
| market | string | |
| currency | string | |
| amount | number | 實收股利金額（已扣稅後） |
| shares | number? | 發放時持股數，選填 |
| payDate | string | ISO8601 |
| externalId | string | |
| syncedAt | string | |

## collection: `calendarEvents`
除權息日／財報日提醒用。
| 欄位 | 型別 | 說明 |
|---|---|---|
| symbol | string | |
| market | string | |
| type | string | `"exDividend"` \| `"earnings"` |
| eventDate | string | ISO8601（僅日期部分有意義） |
| note | string? | |

## collection: `syncMeta`
document ID = broker 名稱（`"sinopac"` / `"schwab"` / `"calendar"`）。
| 欄位 | 型別 | 說明 |
|---|---|---|
| lastSyncAt | string | ISO8601 |
| lastSuccess | boolean | |
| lastError | string? | |

## 不落地的資料（App 端計算，不寫回 Firestore）

- **持股庫存/成本均價/未實現損益**：App 讀取 `trades` 後，用移動平均法即時算，不存 Firestore
- **已實現損益**：同上，賣出當下用當時移動平均成本計算
- **勝率/盈虧比/平均持有天數**：由已實現損益紀錄衍生計算
- 這樣設計是為了避免 App 端與同步腳本各自維護一份庫存邏輯而互相打架；`trades` 是唯一真實來源 (source of truth)

## 認證

- Python 端：用 Firebase Admin SDK + 服務帳戶 JSON（`FIREBASE_SERVICE_ACCOUNT` secret），有完整讀寫權限，不受 Security Rules 限制
- iOS 端：用 Firebase Auth **匿名登入**（單一使用者，不需要註冊畫面），Firestore Security Rules 僅允許該匿名 UID 讀寫（規則檔案見 `firestore.rules`）
