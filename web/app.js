import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  collection,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, OWNER_UID } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

/* ---------- 資料位置 ---------- */

// 登入中的使用者。allowed 是「有沒有被開通」：註冊是開放的，能登入不等於能用。
const session = { uid: null, email: null, allowed: false, owner: false };

// 個人資料放在 users/{uid}/ 底下，兩個帳號彼此讀不到（規則見 firestore.rules）。
// 這兩個 helper 只能在登入後呼叫，session.uid 是空的時候路徑會是錯的，
// 所以刻意讓它直接壞掉而不是預設成某個人的資料。
function myCol(name) {
  if (!session.uid) throw new Error("尚未登入，不能存取個人資料");
  return collection(db, "users", session.uid, name);
}
function myDoc(name, id) {
  if (!session.uid) throw new Error("尚未登入，不能存取個人資料");
  return doc(db, "users", session.uid, name, id);
}

// 現價、代號名稱、匯率、除權息與財報日是市場資料不是個人資料，
// 開通的使用者共用同一份：省 API 額度，也不用為兩個人重複抓同一檔。
const sharedCol = (name) => collection(db, name);
const sharedDoc = (name, id) => doc(db, name, id);

const state = {
  positions: [],
  realized: [],
  lots: [],
  trades: [],
  dividends: [],
  options: [],
  symbols: {},
  settings: {},
  events: [],
  quotes: {},
  fx: {},
  syncMeta: [],
  allowlist: [],
  ready: false,
};

// key 一律用字串：像 "0050" 這種前導零的代號寫成數字會被當成八進位字面值，
// 在 module 的 strict mode 下會直接 SyntaxError。
const SECTORS = {
  "2330": "半導體",
  "2303": "半導體",
  "2454": "半導體",
  "3711": "半導體",
  "2317": "電子零組件",
  "2382": "電腦及週邊",
  "2412": "通信網路",
  "2881": "金融保險",
  "2882": "金融保險",
  "2884": "金融保險",
  "2891": "金融保險",
  "0050": "ETF",
  "0056": "ETF",
  "00878": "ETF",
  "006208": "ETF",
  "1301": "塑膠",
  "1303": "塑膠",
  "2002": "鋼鐵",
  "2603": "航運",
  "2609": "航運",
  "2615": "航運",
  "1216": "食品",
  "2207": "汽車",
  AAPL: "Technology",
  MSFT: "Technology",
  NVDA: "Technology",
  GOOGL: "Technology",
  AMZN: "Consumer",
  TSLA: "Consumer",
  META: "Technology",
  VOO: "ETF",
  SPY: "ETF",
  QQQ: "ETF",
  VTI: "ETF",
};

const DAY_MS = 86400000;

/* ---------- 代號圖示 ---------- */

// 沒有免費可靠的台股 logo 來源；向第三方抓圖等於把持股清單洩漏給那個服務，
// 而且離線就顯示不出來（本站是可離線使用的 PWA），所以圖示一律在本機依代號生成。
const US_ETFS = new Set(["VOO", "SPY", "QQQ", "VTI"]);

// 台股 ETF 代號都以 00 開頭（0050、00878、006208…），SECTORS 沒收錄的代號也適用
const isEtf = (symbol, market) =>
  market === "TW" ? /^00/.test(symbol) : US_ETFS.has(symbol) || SECTORS[symbol] === "ETF";

// 顯示名稱：介面上只有 2330 這種代號很難認，改成「台積電 2330」。
// 台股名稱由 sync/symbols_sync.py 從 TWSE 開放資料寫進 symbols；
// 美股名稱是嘉信匯出檔匯入時從 Description 一併寫入的。查不到就只顯示代號。
// Firestore 的 document ID 不能含斜線（會被當成路徑分隔，BRK/B 會變成三段而寫入失敗）。
// document ID 與 state 的索引鍵一律走這個函式，兩邊才不會一個寫得進去、一個查不到。
const symbolKey = (market, symbol) => `${market}:${String(symbol ?? "").replace(/\//g, "-")}`;

function symbolName(symbol, market = "TW") {
  const hit = state.symbols[symbolKey(market, symbol)];
  return hit && hit.name ? hit.name : "";
}

// 代號與名稱一起顯示。名稱在前、代號在後，跟券商 App 的習慣一致。
function symbolLabel(symbol, market = "TW") {
  const name = symbolName(symbol, market);
  return el("span", { class: "sym-label" }, [
    name ? el("span", { class: "sym-name", text: name }) : null,
    el("span", { class: "mono sym-code", text: String(symbol ?? "") }),
  ]);
}

/* ---------- utils ---------- */

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const fmtDate = (d) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "—";

const CURRENCY_SYMBOL = { TWD: "NT$", USD: "$" };

const fmtMoney = (n, currency = "TWD", digits = 0) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sym = CURRENCY_SYMBOL[currency] || "";
  const abs = Math.abs(n).toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? "-" : ""}${sym}${abs}`;
};

const fmtNum = (n, digits = 2) =>
  n === null || n === undefined || isNaN(n)
    ? "—"
    : n.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// 股利再投資買進的是零碎股（嘉信匯出檔實測最小 0.0415 股），整數位數會顯示成「0 股」
const fmtShares = (n) =>
  n === null || n === undefined || isNaN(n) ? "—" : Number.isInteger(n) ? fmtNum(n, 0) : fmtNum(n, 4);

// 沒有匯率可用時的退路：各幣別各自一行，不併成一個數字。
// 全部金額都是 0（或整包是空的）時沒有幣別可推，由呼叫端指定要用哪一種幣別顯示這個 0。
const fmtMultiLines = (byCurrency, digits = 0, zeroCurrency = "TWD") => {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => Math.abs(v) > 0.0001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([c, v]) => fmtMoney(v, c, digits));
  return parts.length ? parts : [fmtMoney(0, zeroCurrency)];
};

const fmtMulti = (byCurrency, digits = 0) => fmtMultiLines(byCurrency, digits).join(" · ");

const pnlClass = (n) => (n > 0 ? "gain" : n < 0 ? "loss" : "muted");

const sumByCurrency = (items, valueFn) => {
  const out = {};
  for (const it of items) {
    const c = it.currency || "TWD";
    out[c] = (out[c] || 0) + valueFn(it);
  }
  return out;
};

const dominantCurrency = (obj) => {
  const keys = Object.keys(obj);
  if (!keys.length) return "TWD";
  return keys.sort((a, b) => Math.abs(obj[b]) - Math.abs(obj[a]))[0];
};

/* ---------- 匯率換算 ---------- */

// 匯率只讀 fx/USDTWD（同步腳本每日寫入）。讀不到就回 null，呼叫端必須退回分幣別顯示：
// 自己補一個「差不多」的匯率會做出看起來正常、實際是假的總額，比不換算更難發現錯誤。
const usdTwdRate = () => {
  const d = state.fx.USDTWD;
  return d && d.rate > 0 ? d.rate : null;
};

const toTwd = (amount, currency) => {
  if (amount === null || amount === undefined) return null;
  if (currency === "TWD") return amount;
  const rate = usdTwdRate();
  return currency === "USD" && rate ? amount * rate : null;
};

// 只要有一種幣別換不了就整包回 null，不做部分加總（少算一種幣別的總額比分開顯示更誤導）。
const sumTwd = (byCurrency) => {
  let total = 0;
  for (const [c, v] of Object.entries(byCurrency)) {
    const t = toTwd(v, c);
    if (t === null) return null;
    total += t;
  }
  return total;
};

const sectorOf = (symbol) => SECTORS[symbol] || "未分類";

const positionKey = (t) => `${t.market}:${t.symbol}`;

/* ---------- cost basis (移動平均法) ---------- */

// 買進滾動平均成本（手續費計入成本），賣出時以當下均價認列已實現損益。
// 持有天數的起算點在部位從 0 變正時重設，中途加碼不重算加權起始日。
function computeBook(trades) {
  const bySymbol = new Map();
  for (const t of trades) {
    const key = positionKey(t);
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(t);
  }

  const positions = [];
  const lots = [];

  for (const [key, list] of bySymbol) {
    list.sort((a, b) => a.tradeDate - b.tradeDate);
    let shares = 0;
    let avgCost = 0;
    let openedAt = null;
    const [market, symbol] = key.split(":");
    const currency = list[0].currency || (market === "TW" ? "TWD" : "USD");
    // 同一檔如果混了不同來源（手動補登＋嘉信匯入）就標成 manual，不謊稱是券商資料
    const brokers = new Set(list.map((t) => t.broker));
    const broker = brokers.size === 1 ? [...brokers][0] : "manual";

    for (const t of list) {
      const qty = Math.abs(t.quantity || 0);
      if (!qty) continue;
      if (t.side === "buy") {
        if (shares <= 0) openedAt = t.tradeDate;
        const totalCost = shares * avgCost + qty * t.price + (t.fee || 0);
        shares += qty;
        avgCost = shares > 0 ? totalCost / shares : 0;
      } else if (t.side === "sell") {
        const sold = Math.min(qty, shares);
        if (sold > 0) {
          const costBasis = sold * avgCost;
          const proceeds = sold * t.price - (t.fee || 0) - (t.tax || 0);
          lots.push({
            symbol,
            market,
            currency,
            broker,
            sellDate: t.tradeDate,
            quantity: sold,
            proceeds,
            costBasis,
            realizedPnL: proceeds - costBasis,
            holdingDays: openedAt ? Math.max(0, Math.round((t.tradeDate - openedAt) / DAY_MS)) : null,
          });
          shares -= sold;
          if (shares <= 0.000001) {
            shares = 0;
            avgCost = 0;
            openedAt = null;
          }
        }
      }
    }

    if (shares > 0.000001) {
      positions.push({ symbol, market, currency, broker, shares, avgCost, openedAt });
    }
  }

  positions.sort((a, b) => b.shares * b.avgCost - a.shares * a.avgCost);
  lots.sort((a, b) => b.sellDate - a.sellDate);
  return { positions, lots };
}

const marketValue = (p) => {
  const q = state.quotes[symbolKey(p.market, p.symbol)];
  return q && q.price ? p.shares * q.price : null;
};

/* ---------- 兩種來源合併 ---------- */

const SOURCE_LABEL = { sinopac: "永豐", schwab: "嘉信", manual: "手動" };
const COND_LABEL = { Cash: "現股", MarginTrading: "融資", ShortSelling: "融券" };

// 永豐給的是券商算好的結果，直接採用，不重算；手動交易則走移動平均法。
// marketValue / unrealizedPnl 為 null 代表「沒有現價所以算不出來」，和 0 是兩回事。
function allPositions() {
  const out = state.positions.map((p) => ({
    source: "sinopac",
    symbol: p.symbol,
    market: p.market,
    currency: p.currency,
    // 零股的 lots 是 0，用 lots × 1000 回推股數會得到 0，只能用金額回推
    // 券商只給到小數兩位的均價，成本 ÷ 均價 會帶進除法誤差（9038.6002 這種）。
    // 台股不會有小數股，四捨五入才不會顯示出根本不存在的精確度。
    shares: p.avgPrice > 0 ? Math.round(p.totalCost / p.avgPrice) : null,
    avgCost: p.avgPrice,
    totalCost: p.totalCost,
    lastPrice: p.lastPrice || null,
    marketValue: p.marketValue,
    unrealizedPnl: p.unrealizedPnl,
    exDividends: p.exDividends,
    earliestEntryDate: p.earliestEntryDate,
    cond: p.cond,
  }));

  for (const p of computeBook(state.trades).positions) {
    const mv = marketValue(p);
    const q = state.quotes[symbolKey(p.market, p.symbol)];
    out.push({
      source: p.broker,
      symbol: p.symbol,
      market: p.market,
      currency: p.currency,
      shares: p.shares,
      avgCost: p.avgCost,
      totalCost: p.shares * p.avgCost,
      lastPrice: q && q.price ? q.price : null,
      marketValue: mv,
      unrealizedPnl: mv === null ? null : mv - p.shares * p.avgCost,
      exDividends: 0,
      earliestEntryDate: p.openedAt,
      cond: null,
    });
  }

  out.sort((a, b) => b.totalCost - a.totalCost);
  return out;
}

function allRealized() {
  const out = state.realized.map((r) => ({
    source: "sinopac",
    symbol: r.symbol,
    market: r.market,
    currency: r.currency,
    sellDate: r.sellDate,
    pnl: r.pnl,
    costBasis: r.entryCost,
    // 券商只給每股賣出價，沒有賣出總額，不硬湊
    proceeds: null,
    sellPrice: r.sellPrice,
    quantity: null,
    holdingDays: r.holdingDays,
    exDividendAmt: r.exDividendAmt,
  }));

  for (const l of computeBook(state.trades).lots) {
    out.push({
      source: l.broker,
      symbol: l.symbol,
      market: l.market,
      currency: l.currency,
      sellDate: l.sellDate,
      pnl: l.realizedPnL,
      costBasis: l.costBasis,
      proceeds: l.proceeds,
      sellPrice: null,
      quantity: l.quantity,
      holdingDays: l.holdingDays,
      exDividendAmt: 0,
    });
  }

  out.sort((a, b) => b.sellDate - a.sellDate);
  return out;
}

// 永豐沒有股利 API，配息只能拿到「累計金額」：庫存的 exDividends 與平倉的 exDividendAmt。
function brokerDividendTotals() {
  const bySymbol = new Map();
  const add = (r, amount, kind) => {
    if (!amount) return;
    const key = `${r.market}:${r.symbol}`;
    if (!bySymbol.has(key)) {
      bySymbol.set(key, {
        symbol: r.symbol,
        market: r.market,
        currency: r.currency,
        amount: 0,
        holding: 0,
        closed: 0,
      });
    }
    const s = bySymbol.get(key);
    s.amount += amount;
    s[kind] += amount;
  };
  for (const p of state.positions) add(p, p.exDividends, "holding");
  for (const r of state.realized) add(r, r.exDividendAmt, "closed");
  return [...bySymbol.values()].sort((a, b) => b.amount - a.amount);
}

// 交易紀錄頁的時間軸：買進來自 lots、永豐的賣出來自 realized、手動輸入的買賣來自 trades。
// realized 只有永豐的紀錄，手動賣出從 trades 進來，兩邊不會重複計入。
function allTransactions() {
  const out = [];

  for (const l of state.lots) {
    out.push({
      key: `lot:${l.id}`,
      side: "buy",
      source: "sinopac",
      symbol: l.symbol,
      market: l.market,
      currency: l.currency,
      date: l.tradeDate,
      amount: l.cost,
      lots: l.lots,
      unitPrice: l.unitPrice,
      fee: l.fee,
      status: l.status,
      pnl: null,
      shares: null,
      costBasis: null,
      holdingDays: null,
      trade: null,
    });
  }

  for (const r of state.realized) {
    out.push({
      key: `realized:${r.id}`,
      side: "sell",
      source: "sinopac",
      symbol: r.symbol,
      market: r.market,
      currency: r.currency,
      date: r.sellDate,
      amount: null,
      lots: r.lots,
      unitPrice: r.sellPrice,
      fee: r.fee + r.tax,
      status: null,
      pnl: r.pnl,
      shares: null,
      costBasis: r.entryCost,
      holdingDays: r.holdingDays,
      trade: null,
    });
  }

  for (const t of state.trades) {
    out.push({
      key: `trade:${t.id}`,
      side: t.side,
      source: t.broker,
      symbol: t.symbol,
      market: t.market,
      currency: t.currency,
      date: t.tradeDate,
      amount: t.quantity * t.price,
      lots: 0,
      unitPrice: t.price,
      fee: t.fee + t.tax,
      status: null,
      pnl: null,
      shares: t.quantity,
      costBasis: null,
      holdingDays: null,
      trade: t,
    });
  }

  out.sort((a, b) => b.date - a.date || a.symbol.localeCompare(b.symbol));
  return out;
}

/* ---------- firestore ---------- */

function normalizeTrade(id, d) {
  return {
    id,
    broker: d.broker || "manual",
    symbol: String(d.symbol ?? ""),
    market: d.market || "TW",
    side: d.side === "sell" ? "sell" : "buy",
    quantity: Number(d.quantity) || 0,
    price: Number(d.price) || 0,
    fee: Number(d.fee) || 0,
    tax: Number(d.tax) || 0,
    currency: d.currency || (d.market === "US" ? "USD" : "TWD"),
    tradeDate: parseDate(d.tradeDate) || new Date(0),
    note: d.note || "",
    externalId: d.externalId || "",
  };
}

function normalizePosition(id, d) {
  return {
    id,
    broker: d.broker || "sinopac",
    symbol: String(d.symbol ?? ""),
    market: d.market || "TW",
    currency: d.currency || "TWD",
    avgPrice: Number(d.avgPrice) || 0,
    lastPrice: Number(d.lastPrice) || 0,
    totalCost: Number(d.totalCost) || 0,
    marketValue: Number(d.marketValue) || 0,
    unrealizedPnl: Number(d.unrealizedPnl) || 0,
    exDividends: Number(d.exDividends) || 0,
    earliestEntryDate: parseDate(d.earliestEntryDate),
    cond: d.cond || "Cash",
  };
}

function normalizeRealized(id, d) {
  return {
    id,
    broker: d.broker || "sinopac",
    symbol: String(d.symbol ?? ""),
    market: d.market || "TW",
    currency: d.currency || "TWD",
    sellDate: parseDate(d.sellDate) || new Date(0),
    lots: Number(d.lots) || 0,
    sellPrice: Number(d.sellPrice) || 0,
    pnl: Number(d.pnl) || 0,
    entryCost: Number(d.entryCost) || 0,
    fee: Number(d.fee) || 0,
    tax: Number(d.tax) || 0,
    exDividendAmt: Number(d.exDividendAmt) || 0,
    entryDate: parseDate(d.entryDate),
    // 券商算不出加權平均進場日時 entryDate / holdingDays 都會缺，不補估計值
    holdingDays:
      d.holdingDays === null || d.holdingDays === undefined || d.holdingDays === ""
        ? null
        : Number(d.holdingDays),
  };
}

function normalizeOption(id, d) {
  const expiry = String(d.expiry || "");
  const status = ["expired", "assigned", "closed"].includes(d.status) ? d.status : "open";
  return {
    id,
    broker: d.broker || "schwab",
    underlying: String(d.underlying ?? ""),
    market: d.market || "US",
    currency: d.currency || "USD",
    kind: d.kind === "C" ? "C" : "P",
    side: d.side === "long" ? "long" : "short",
    strike: Number(d.strike) || 0,
    expiry,
    contracts: Number(d.contracts) || 0,
    openDate: d.openDate || null,
    closeDate: d.closeDate || null,
    premium: Number(d.premium) || 0,
    fee: Number(d.fee) || 0,
    status,
    realizedPnl:
      d.realizedPnl === null || d.realizedPnl === undefined ? null : Number(d.realizedPnl),
    note: d.note || "",
    // 過了到期日卻沒有結算紀錄，多半是匯出區間沒涵蓋，不能當成還持有的部位
    staleOpen: status === "open" && expiry !== "" && expiry < new Date().toISOString().slice(0, 10),
  };
}

function normalizeLot(id, d) {
  return {
    id,
    broker: d.broker || "sinopac",
    symbol: String(d.symbol ?? ""),
    market: d.market || "TW",
    currency: d.currency || "TWD",
    status: d.status === "closed" ? "closed" : "open",
    tradeDate: parseDate(d.tradeDate) || new Date(0),
    lots: Number(d.lots) || 0,
    cost: Number(d.cost) || 0,
    // open 的庫存明細沒給單價，缺就是缺，不用 cost 回推
    unitPrice:
      d.unitPrice === null || d.unitPrice === undefined || d.unitPrice === ""
        ? null
        : Number(d.unitPrice),
    fee: Number(d.fee) || 0,
    exDividends: Number(d.exDividends) || 0,
    dseq: d.dseq || "",
  };
}

function normalizeFx(id, d) {
  return {
    id,
    base: d.base || "",
    quote: d.quote || "",
    rate: Number(d.rate) || 0,
    source: d.source || "",
    updatedAt: parseDate(d.updatedAt),
  };
}

// 換帳號時舊的監聽還掛在前一個人的路徑上，不取消掉會一直噴 permission-denied，
// 而且前一個人的資料會殘留在畫面上。登出時一律全部收掉並清空 state。
let unsubs = [];

function unsubscribeAll() {
  for (const stop of unsubs) {
    try {
      stop();
    } catch {
      /* 已經斷線的監聽再取消一次不影響 */
    }
  }
  unsubs = [];
  Object.assign(state, {
    positions: [], realized: [], lots: [], trades: [], dividends: [], options: [],
    symbols: {}, settings: {}, events: [], quotes: {}, fx: {}, syncMeta: [],
    allowlist: [], ready: false,
  });
}

function subscribe() {
  unsubs.push(onSnapshot(myCol("positions"), (snap) => {
    state.positions = snap.docs.map((d) => normalizePosition(d.id, d.data()));
    render();
  }));

  unsubs.push(onSnapshot(myCol("realized"), (snap) => {
    state.realized = snap.docs.map((d) => normalizeRealized(d.id, d.data()));
    state.realized.sort((a, b) => b.sellDate - a.sellDate);
    render();
  }));

  unsubs.push(onSnapshot(myCol("lots"), (snap) => {
    state.lots = snap.docs.map((d) => normalizeLot(d.id, d.data()));
    state.lots.sort((a, b) => b.tradeDate - a.tradeDate);
    render();
  }));

  unsubs.push(onSnapshot(myDoc("settings", "import"), (snap) => {
    state.settings = snap.exists() ? snap.data() : {};
    render();
  }));

  unsubs.push(onSnapshot(sharedCol("symbols"), (snap) => {
    const map = {};
    for (const d of snap.docs) {
      const v = d.data();
      map[d.id] = { symbol: v.symbol, market: v.market, name: v.name || "" };
    }
    state.symbols = map;
    render();
  }));

  unsubs.push(onSnapshot(myCol("options"), (snap) => {
    state.options = snap.docs.map((d) => normalizeOption(d.id, d.data()));
    state.options.sort((a, b) => (b.openDate || "").localeCompare(a.openDate || ""));
    render();
  }));

  unsubs.push(onSnapshot(myCol("trades"), (snap) => {
    state.trades = snap.docs.map((d) => normalizeTrade(d.id, d.data()));
    state.trades.sort((a, b) => b.tradeDate - a.tradeDate);
    render();
  }));

  unsubs.push(onSnapshot(myCol("dividends"), (snap) => {
    state.dividends = snap.docs.map((d) => {
      const v = d.data();
      return {
        id: d.id,
        broker: v.broker || "",
        symbol: String(v.symbol ?? ""),
        market: v.market || "TW",
        currency: v.currency || (v.market === "US" ? "USD" : "TWD"),
        amount: Number(v.amount) || 0,
        shares: v.shares ? Number(v.shares) : null,
        payDate: parseDate(v.payDate) || new Date(0),
      };
    });
    state.dividends.sort((a, b) => b.payDate - a.payDate);
    render();
  }));

  unsubs.push(onSnapshot(sharedCol("calendarEvents"), (snap) => {
    state.events = snap.docs.map((d) => {
      const v = d.data();
      return {
        id: d.id,
        symbol: String(v.symbol ?? ""),
        market: v.market || "TW",
        type: v.type || "exDividend",
        eventDate: parseDate(v.eventDate) || new Date(0),
        note: v.note || "",
      };
    });
    state.events.sort((a, b) => a.eventDate - b.eventDate);
    render();
  }));

  unsubs.push(onSnapshot(sharedCol("quotes"), (snap) => {
    const q = {};
    for (const d of snap.docs) {
      const v = d.data();
      q[d.id] = { price: Number(v.price) || 0, source: v.source || "manual", updatedAt: parseDate(v.updatedAt) };
    }
    state.quotes = q;
    render();
  }));

  unsubs.push(onSnapshot(sharedCol("fx"), (snap) => {
    const fx = {};
    for (const d of snap.docs) fx[d.id] = normalizeFx(d.id, d.data());
    state.fx = fx;
    render();
  }));

  // 開通名單只有擁有者讀得到，其他人訂閱會被規則拒絕，所以不要無條件掛上去
  if (session.owner) {
    unsubs.push(onSnapshot(sharedCol("allowlist"), (snap) => {
      state.allowlist = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
      render();
    }));
  }

  unsubs.push(onSnapshot(myCol("syncMeta"), (snap) => {
    state.syncMeta = snap.docs.map((d) => ({
      id: d.id,
      lastSyncAt: parseDate(d.data().lastSyncAt),
      lastSuccess: d.data().lastSuccess !== false,
      lastError: d.data().lastError || "",
    }));
    renderSyncBadge();
  }));
}

async function saveQuote(market, symbol, price) {
  await setDoc(
    sharedDoc("quotes", symbolKey(market, symbol)),
    { symbol, market, price, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

async function saveTradeNote(id, note) {
  await updateDoc(myDoc("trades", id), { note });
}

async function addManualTrade(data) {
  const id = `manual_${Date.now()}`;
  await setDoc(myDoc("trades", id), {
    ...data,
    broker: "manual",
    externalId: id,
    syncedAt: new Date().toISOString(),
  });
}

async function deleteTrade(id) {
  await deleteDoc(myDoc("trades", id));
}

/* ---------- 刪除交易紀錄 ---------- */

// 嘉信匯出檔是整段歷史，刪掉的紀錄下次匯入會原封不動長回來。
// 所以整檔刪除時把代號寫進忽略清單，匯入與抓現價都會跳過它，刪除才是持久的。
async function setIgnoredSymbols(symbols) {
  await setDoc(
    myDoc("settings", "import"),
    { ignoredSymbols: symbols, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

// 一筆交易可能同時對應多個 collection 的文件（買進批次、平倉、選擇權合約…），
// 這裡按代號把相關文件一起清掉，不然畫面上會留下半套資料。
function relatedDocRefs(symbols, market) {
  const set = new Set(symbols);
  const refs = [];
  for (const t of state.trades) {
    if (set.has(t.symbol) && t.market === market) refs.push(myDoc("trades", t.id));
  }
  for (const d of state.dividends) {
    if (set.has(d.symbol) && d.market === market) refs.push(myDoc("dividends", d.id));
  }
  for (const l of state.lots) {
    if (set.has(l.symbol) && l.market === market) refs.push(myDoc("lots", l.id));
  }
  for (const r of state.realized) {
    if (set.has(r.symbol) && r.market === market) refs.push(myDoc("realized", r.id));
  }
  for (const o of state.options) {
    if (set.has(o.underlying) && o.market === market) refs.push(myDoc("options", o.id));
  }
  for (const sym of set) {
    refs.push(sharedDoc("quotes", symbolKey(market, sym)));
    refs.push(sharedDoc("symbols", symbolKey(market, sym)));
  }
  return refs;
}

async function deleteDocsInBatches(refs, onProgress) {
  let done = 0;
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
    done += Math.min(BATCH_LIMIT, refs.length - i);
    if (onProgress) onProgress(done, refs.length);
  }
  return done;
}

/* ---------- 嘉信匯出檔解析 ---------- */

// Schwab 的 API 這個帳戶申請不到（開發者平台 2FA 只收美國門號），改用網站匯出的 JSON。
// 以下分類依實際匯出檔 1362 筆逐項確認，不是照文件猜的。
const SCHWAB_ACTIONS = {
  buy: new Set(["Buy", "Reinvest Shares"]), // Reinvest Shares 是股利再投入，有股數與價格，就是買進
  sell: new Set(["Sell"]),
  dividend: new Set([
    "Qualified Dividend", "Cash Dividend", "Non-Qualified Div", "Qual Div Reinvest",
    "Pr Yr Non Qual Div", "Short Term Cap Gain", "Bond Interest", "Credit Interest",
  ]),
  // 稅費用負數存進 dividends，加總時自然淨額，不用去跟個別股利配對（日期常對不起來）
  tax: new Set([
    "NRA Tax Adj", "ADR Mgmt Fee", "Foreign Tax Paid", "NRA Withholding",
    "Margin Interest", "Interest Adj", "Pr Yr NRA Tax",
  ]),
  optionOpen: new Set(["Sell to Open", "Buy to Open"]),
  optionClose: new Set(["Expired", "Assigned", "Buy to Close", "Sell to Close"]),
  // 現金搬移與公司行動，不是交易。Journaled Shares 名字誤導，實測沒有代號也沒有股數，
  // 內容是 TD Ameritrade 併入嘉信的現金搬移。Expired Rights 是認購權證到期不是選擇權。
  ignore: new Set([
    "Journaled Shares", "Internal Transfer", "Journal", "Wire Received",
    "Reverse Split", "Stock Split", "Stock Split Adj", "Cash In Lieu",
    "Dist Rights Trans", "Reinvestment Adj", "Expired Rights",
  ]),
};

const parseMoney = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
};

// 選擇權的日期是「07/20/2026 as of 07/17/2026」，as of 後面才是實際發生日
const parseSchwabDate = (v) => {
  const text = String(v || "");
  const part = text.includes(" as of ") ? text.split(" as of ")[1] : text;
  const m = part.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

const OPTION_SYMBOL_RE = /^(\S+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([CP])\b/;

// 實測有一筆 Assigned 的 Symbol 是空字串，合約寫在 Description（「5 TSLL1 12/19/2025 22.00 C」）
function parseOptionContract(row) {
  const fromSymbol = OPTION_SYMBOL_RE.exec(String(row.Symbol || "").trim());
  const desc = String(row.Description || "").trim().replace(/^\d+\s+/, "");
  const m = fromSymbol || OPTION_SYMBOL_RE.exec(desc);
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: `${m[4]}-${m[2]}-${m[3]}`,
    strike: parseFloat(m[5]),
    kind: m[6],
  };
}

const contractKey = (c) =>
  `schwab_${String(c.underlying).replace(/\//g, "-")}_${c.expiry}_${c.strike}_${c.kind}`;

// 同一筆再匯入一次要落在同一個 doc，不能變兩筆。用內容湊出穩定 id。
const stableId = (parts) =>
  parts.map((p) => String(p ?? "").replace(/[^\w.-]/g, "")).join("_");

const isTransactionNarrative = (desc) =>
  /TDA TRAN|@\s*[\d.]|^(BOUGHT|SOLD)/i.test(String(desc || ""));

const NAME_KEEP_UPPER = new Set(["ETF", "REIT", "ADR", "USA", "US", "II", "III", "IV", "AG", "SA", "NV", "PLC"]);

const titleCaseName = (raw) =>
  String(raw || "")
    .trim()
    .split(/\s+/)
    .map((w) =>
      NAME_KEEP_UPPER.has(w.toUpperCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");

function parseSchwabExport(json, ignoredSymbols = []) {
  const rows = (json && json.BrokerageTransactions) || [];
  const ignoredSet = new Set(ignoredSymbols);
  const out = {
    trades: [], dividends: [], options: [], names: {}, skippedBySymbol: 0,
    ignored: 0, ignoredActions: {}, unclassified: [],
    range: { from: json?.FromDate || "", to: json?.ToDate || "" },
    total: rows.length,
  };
  const contracts = new Map();
  const optionRows = [];
  const nameTally = {};

  for (const row of rows) {
    const action = String(row.Action || "").trim();
    const date = parseSchwabDate(row.Date);
    const symbol = String(row.Symbol || "").trim();
    const amount = parseMoney(row.Amount);
    const fee = parseMoney(row["Fees & Comm"]);

    // 使用者刪掉整檔後會列進忽略清單，不然每次匯入都會把刪掉的資料長回來
    if (symbol && ignoredSet.has(symbol)) {
      out.skippedBySymbol++;
      continue;
    }

    if (SCHWAB_ACTIONS.ignore.has(action)) {
      out.ignored++;
      out.ignoredActions[action] = (out.ignoredActions[action] || 0) + 1;
      continue;
    }

    if (SCHWAB_ACTIONS.optionOpen.has(action) || SCHWAB_ACTIONS.optionClose.has(action)) {
      const c = parseOptionContract(row);
      if (!c || !date) {
        out.unclassified.push({ action, symbol, date: row.Date, why: "選擇權合約代號無法解析" });
        continue;
      }
      optionRows.push({ contract: c, action, date, row, amount, fee });
      continue;
    }

    const isBuy = SCHWAB_ACTIONS.buy.has(action);
    const isSell = SCHWAB_ACTIONS.sell.has(action);
    if (isBuy || isSell) {
      const quantity = Math.abs(parseFloat(row.Quantity) || 0);
      const price = parseMoney(row.Price);
      if (!symbol || !date || !quantity) {
        out.unclassified.push({ action, symbol, date: row.Date, why: "缺少代號、日期或股數" });
        continue;
      }
      if (row.Description) {
        const tally = (nameTally[symbol] = nameTally[symbol] || {});
        tally[row.Description] = (tally[row.Description] || 0) + 1;
      }
      const externalId = stableId([date, symbol, isBuy ? "B" : "S", quantity, price, amount]);
      out.trades.push({
        broker: "schwab", symbol, market: "US", currency: "USD",
        side: isBuy ? "buy" : "sell",
        quantity, price, fee, tax: 0,
        tradeDate: `${date}T00:00:00Z`,
        externalId,
        action,
      });
      continue;
    }

    const isDiv = SCHWAB_ACTIONS.dividend.has(action);
    const isTax = SCHWAB_ACTIONS.tax.has(action);
    if (isDiv || isTax) {
      if (!date) {
        out.unclassified.push({ action, symbol, date: row.Date, why: "日期無法解析" });
        continue;
      }
      out.dividends.push({
        broker: "schwab", symbol: symbol || "(現金)", market: "US", currency: "USD",
        amount, // 稅費本來就是負數，加總自然淨額
        kind: isTax ? "tax" : action === "Credit Interest" || action === "Bond Interest" ? "interest" : "dividend",
        payDate: `${date}T00:00:00Z`,
        externalId: stableId([date, symbol || "CASH", action, amount]),
        action,
      });
      continue;
    }

    out.unclassified.push({ action, symbol, date: row.Date, why: "未知的交易類型" });
  }

  // 先建開倉，平倉再回頭配對：標的分割後選擇權代號會被改成調整序列（實測 TSLL 平倉時
  // 變成 TSLL1），逐列處理會把同一個合約拆成「開倉沒平倉」和「平倉沒開倉」兩筆。
  for (const { contract, action, date, row, amount, fee } of optionRows) {
    if (!SCHWAB_ACTIONS.optionOpen.has(action)) continue;
    const key = contractKey(contract);
    contracts.set(key, {
      ...contract, id: key, broker: "schwab", market: "US", currency: "USD",
      side: action === "Sell to Open" ? "short" : "long",
      contracts: Math.abs(parseFloat(row.Quantity) || 0),
      premium: amount, // 賣方為正、買方為負，已含手續費
      fee,
      status: "open", openDate: date, closeDate: null, realizedPnl: null,
    });
  }

  // 只在完全比對不到時才去掉標的尾碼數字再試一次，避免誤傷本來就以數字結尾的代號
  const matchAdjusted = (c) => {
    const base = c.underlying.replace(/\d+$/, "");
    if (base === c.underlying) return null;
    const key = contractKey({ ...c, underlying: base });
    return contracts.has(key) ? key : null;
  };

  for (const { contract, action, date, row } of optionRows) {
    if (SCHWAB_ACTIONS.optionOpen.has(action)) continue;
    const exact = contractKey(contract);
    const key = contracts.has(exact) ? exact : matchAdjusted(contract) || exact;
    const existing = contracts.get(key) || {
      ...contract, id: exact, broker: "schwab", market: "US", currency: "USD",
      side: "short", contracts: 0, premium: 0, fee: 0,
      status: "open", openDate: null, closeDate: null, realizedPnl: null,
    };
    existing.status = action === "Assigned" ? "assigned" : action === "Expired" ? "expired" : "closed";
    existing.closeDate = date;
    if (!existing.contracts) existing.contracts = Math.abs(parseFloat(row.Quantity) || 0);
    contracts.set(key, existing);
  }

  for (const c of contracts.values()) {
    // 到期作廢或被指派，權利金就是這個合約的損益。被指派時標的的買賣另有一筆 Buy/Sell
    // 紀錄（實測確認），成本由那筆承擔，這裡再合成一次會重複計算。
    if (c.status !== "open") c.realizedPnl = c.premium;
    // 早就過期卻沒有平倉紀錄，通常是匯出區間沒涵蓋到那次結算，標記出來而不是當成還持有
    c.staleOpen = c.status === "open" && c.expiry < new Date().toISOString().slice(0, 10);
    out.options.push(c);
  }
  // Description 有時是搬帳的交易敘述（「TDA TRAN - Bought 1 (BRK B) @311.82」）而不是公司名。
  // 排掉那些之後取出現次數最多的；全部都是敘述就不給名稱，介面退回只顯示代號。
  for (const [symbol, tally] of Object.entries(nameTally)) {
    const best = Object.entries(tally)
      .filter(([desc]) => !isTransactionNarrative(desc))
      .sort((a, b) => b[1] - a[1])[0];
    if (best) out.names[symbol] = titleCaseName(best[0]);
  }

  out.options.sort((a, b) => String(b.openDate || "").localeCompare(String(a.openDate || "")));
  return out;
}

// Firestore 單批上限 500 筆，這份匯出檔會產生上千份文件
const BATCH_LIMIT = 450;

async function commitInBatches(writes, onProgress) {
  let done = 0;
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const w of writes.slice(i, i + BATCH_LIMIT)) batch.set(w.ref, w.data, { merge: true });
    await batch.commit();
    done += Math.min(BATCH_LIMIT, writes.length - i);
    if (onProgress) onProgress(done, writes.length);
  }
  return done;
}

async function importSchwab(parsed, onProgress) {
  const syncedAt = new Date().toISOString();
  const writes = [];

  for (const t of parsed.trades) {
    const { action, ...data } = t;
    // note 是使用者自己寫的，重新匯入不可覆寫，所以不放進 payload
    writes.push({ ref: myDoc("trades", `schwab_${t.externalId}`), data: { ...data, syncedAt } });
  }
  for (const d of parsed.dividends) {
    const { action, ...data } = d;
    writes.push({ ref: myDoc("dividends", `schwab_${d.externalId}`), data: { ...data, syncedAt } });
  }
  for (const o of parsed.options) {
    const { id, staleOpen, ...data } = o;
    writes.push({ ref: myDoc("options", id), data: { ...data, syncedAt } });
  }
  // 匯出檔的 Description 就是公司名稱，順便存起來讓介面顯示「Tesla Inc TSLA」
  for (const [symbol, name] of Object.entries(parsed.names)) {
    writes.push({
      ref: sharedDoc("symbols", symbolKey("US", symbol)),
      data: { symbol, market: "US", name, source: "schwab", updatedAt: syncedAt },
    });
  }

  await commitInBatches(writes, onProgress);
  return writes.length;
}

/* ---------- charts ---------- */

// 軸標籤空間有限，用 K/M 縮寫，不然長金額會被裁掉
const fmtAxis = (n, currency) => {
  const sym = CURRENCY_SYMBOL[currency] || "";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${sym}${Math.round(abs)}`;
};

function lineChart(points, currency) {
  const W = 640;
  const H = 220;
  const padL = 52;
  const padR = 20;
  const padT = 12;
  const padB = 28;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const ns = (tag, attrs) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  if (points.length < 2) {
    const t = ns("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "axis-text" });
    t.textContent = "資料點不足，無法繪圖";
    svg.appendChild(t);
    return svg;
  }

  const values = points.map((p) => p.value);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    max = min + 1;
  }
  const pad = (max - min) * 0.1;
  min -= pad;
  max += pad;

  const x = (i) => padL + (i * (W - padL - padR)) / (points.length - 1);
  const y = (v) => padT + ((max - v) * (H - padT - padB)) / (max - min);

  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const yy = y(v);
    svg.appendChild(ns("line", { x1: padL, y1: yy, x2: W - padR, y2: yy, class: "grid-line" }));
    const label = ns("text", { x: padL - 6, y: yy + 3, "text-anchor": "end", class: "axis-text" });
    label.textContent = fmtAxis(v, currency);
    svg.appendChild(label);
  }

  const zeroY = y(0);
  if (zeroY > padT && zeroY < H - padB) {
    svg.appendChild(
      ns("line", {
        x1: padL,
        y1: zeroY,
        x2: W - padR,
        y2: zeroY,
        stroke: "currentColor",
        "stroke-width": "1",
        "stroke-dasharray": "3 3",
        opacity: "0.35",
      })
    );
  }

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;
  svg.appendChild(ns("path", { d: area, class: "series-area" }));
  svg.appendChild(ns("path", { d: line, class: "series-line" }));

  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    if (i % labelStep === 0 || i === points.length - 1) {
      const last = i === points.length - 1;
      const t = ns("text", {
        x: x(i),
        y: H - 8,
        "text-anchor": i === 0 ? "start" : last ? "end" : "middle",
        class: "axis-text",
      });
      t.textContent = p.label;
      svg.appendChild(t);
    }
  });

  const last = points[points.length - 1];
  svg.appendChild(ns("circle", { cx: x(points.length - 1), cy: y(last.value), r: 3, class: "dot" }));

  return svg;
}

const DONUT_COLORS = [
  "#2f81f7",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#a371f7",
  "#db61a2",
  "#1f6feb",
  "#238636",
  "#bb8009",
  "#da3633",
];

function donutChart(slices) {
  const size = 200;
  const r = 80;
  const inner = 50;
  const cx = size / 2;
  const cy = size / 2;
  const total = slices.reduce((s, x) => s + x.value, 0);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("style", "max-width:200px;margin:0 auto;min-width:0");

  if (!total) return svg;

  let angle = -Math.PI / 2;
  slices.forEach((s, idx) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const ix2 = cx + inner * Math.cos(end);
    const iy2 = cy + inner * Math.sin(end);
    const ix1 = cx + inner * Math.cos(angle);
    const iy1 = cy + inner * Math.sin(angle);
    p.setAttribute(
      "d",
      `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${ix2},${iy2} A${inner},${inner} 0 ${large} 0 ${ix1},${iy1} Z`
    );
    p.setAttribute("fill", DONUT_COLORS[idx % DONUT_COLORS.length]);
    svg.appendChild(p);
    angle = end;
  });

  return svg;
}

/* ---------- view helpers ---------- */

const box = (title, bodyNodes, headerExtra = null) => {
  const children = [];
  if (title) {
    const h = el("div", { class: "box-header" }, [el("span", { text: title })]);
    if (headerExtra) {
      h.appendChild(el("span", { class: "spacer" }));
      h.appendChild(headerExtra);
    }
    children.push(h);
  }
  for (const n of [].concat(bodyNodes)) children.push(n);
  return el("div", { class: "box" }, children);
};

const blankslate = (title, sub) =>
  el("div", { class: "blankslate" }, [
    el("div", { class: "big", text: title }),
    sub ? el("div", { text: sub }) : null,
  ]);

// value 可以是字串或多幣別的字串陣列；多行時字級縮小，避免在數字中間折行。
const statTile = (label, value, sub, cls) => {
  const lines = [].concat(value);
  const valueBox = el("div", { class: `value mono ${cls || ""}${lines.length > 1 ? " multi" : ""}` });
  for (const line of lines) valueBox.appendChild(el("div", { text: line }));
  return el("div", { class: "stat" }, [
    el("div", { class: "label", text: label }),
    valueBox,
    sub ? el("div", { class: "sub", text: sub }) : null,
  ]);
};

// 每段各自 nowrap：窄螢幕只在段落之間換行，不會把金額或中文詞彙切一半
const subLine = (parts, cls = "row-sub mono") => {
  const node = el("div", { class: cls });
  parts.filter(Boolean).forEach((p, i) => {
    if (i) node.appendChild(document.createTextNode(" · "));
    node.appendChild(el("span", { class: "nw", text: p }));
  });
  return node;
};

const segmented = (options, current, onChange) => {
  const wrap = el("div", { class: "seg" });
  for (const [value, label] of options) {
    wrap.appendChild(
      el("button", {
        class: value === current ? "active" : "",
        text: label,
        onclick: () => onChange(value),
      })
    );
  }
  return wrap;
};

/* ---------- 市場鏡片 ---------- */

const MARKET_LABEL = { all: "全部", TW: "台股", US: "美股" };

const inMarket = (x) => viewOptions.market === "all" || x.market === viewOptions.market;

// 每一頁的內容第一列都是這個控制項，位置固定才會像全站共用的鏡片而不是某頁的篩選器。
// 不做成 tabnav 下方的常駐橫條：分頁列在 375px 已經要橫向滑，再多一條會壓縮到內容，
// 而提醒與報表兩頁本來就不該被市場篩選，常駐橫條在那裡只會是誤導。
const marketBar = () =>
  el("div", { class: "lens" }, [
    segmented(
      [
        ["TW", "台股"],
        ["US", "美股"],
        ["all", "全部"],
      ],
      viewOptions.market,
      (v) => {
        viewOptions.market = v;
        viewOptions.ledgerPage = 1;
        render();
      }
    ),
  ]);

const marketHint = () =>
  viewOptions.market === "all"
    ? null
    : `目前只看${MARKET_LABEL[viewOptions.market]}，切換上方的市場可以看其他部位`;

const filteredBlank = (title, sub) => blankslate(title, marketHint() || sub);

/* ---------- 匯率說明 ---------- */

// 換算後的數字會隨匯率變動，不能悄悄折進總額裡：用到哪個匯率、什麼時候更新的都要看得到。
const fxAppliedNote = () => {
  const d = state.fx.USDTWD;
  const meta = [d.updatedAt ? `${fmtDate(d.updatedAt)} 更新` : null, d.source].filter(Boolean).join(" · ");
  return el("div", { class: "fx-note" }, [
    el("span", { text: "美股已換算併入台幣：" }),
    el("span", { class: "rate mono nw", text: `1 USD = ${fmtMoney(d.rate, "TWD", 3)}` }),
    meta ? el("span", { class: "nw", text: `（${meta}）` }) : null,
  ]);
};

const fxMissingNote = () =>
  el("div", {
    class: "flash",
    text:
      "缺少 USD/TWD 匯率，美股金額維持原幣別分開顯示。匯率由每日同步寫入 fx/USDTWD，" +
      "還沒寫入前不會自行推估，以免總額看起來正常卻是假的。",
  });

/* ---------- views ---------- */

const viewOptions = {
  // 市場是全站共用的鏡片，不是單一頁面的篩選器，換頁後要保持不變
  market: "all",
  chartBucket: "month",
  chartCurrency: null,
  exposureMode: "symbol",
  exposureCurrency: null,
  reportYear: null,
  ledgerQuery: "",
  ledgerYear: "all",
  ledgerMonth: "all",
  ledgerPage: 1,
};

function viewDashboard() {
  const positions = allPositions().filter(inMarket);
  const lots = allRealized().filter(inMarket);
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  const cost = sumByCurrency(positions, (p) => p.totalCost);
  const unreal = {};
  const value = {};
  const valuedCost = {}; // 只累計「有現價因此估得出市值」的部位成本，報酬率才不會拿不同母體相比
  let missingQuotes = 0;
  for (const p of positions) {
    if (p.unrealizedPnl === null) {
      missingQuotes++;
    } else {
      unreal[p.currency] = (unreal[p.currency] || 0) + p.unrealizedPnl;
      value[p.currency] = (value[p.currency] || 0) + p.marketValue;
      valuedCost[p.currency] = (valuedCost[p.currency] || 0) + p.totalCost;
    }
  }
  const realizedAll = sumByCurrency(lots, (l) => l.pnl);
  const thisYear = new Date().getFullYear();
  const realizedYear = sumByCurrency(
    lots.filter((l) => l.sellDate.getFullYear() === thisYear),
    (l) => l.pnl
  );
  const brokerDividends = brokerDividendTotals().filter(inMarket);
  const manualDividends = state.dividends.filter(inMarket);
  const brokerDividendCount = brokerDividends.length;
  const dividendTotal = sumByCurrency([...manualDividends, ...brokerDividends], (d) => d.amount);

  // 只看單一市場時整頁就是同一種幣別，直接用原幣顯示；只有「全部」才需要換算成台幣。
  const maps = [cost, unreal, value, valuedCost, realizedAll, realizedYear, dividendTotal];
  const crossCurrency =
    viewOptions.market === "all" && maps.some((m) => Object.keys(m).some((c) => c !== "TWD"));
  const converted = crossCurrency && usdTwdRate() !== null;

  const zeroCurrency = viewOptions.market === "US" ? "USD" : "TWD";
  const tileValue = (byCurrency) => {
    const twd = converted ? sumTwd(byCurrency) : null;
    return twd === null ? fmtMultiLines(byCurrency, 0, zeroCurrency) : fmtMoney(twd, "TWD");
  };
  const tileClass = (byCurrency) => {
    const twd = converted ? sumTwd(byCurrency) : null;
    return pnlClass(twd === null ? byCurrency[dominantCurrency(byCurrency)] || 0 : twd);
  };

  // 換算後的市值只能跟同樣換算過的成本比，不然報酬率會拿台幣市值除以混幣別成本。
  const valueTwd = converted ? sumTwd(value) : null;
  const valuedCostTwd = converted ? sumTwd(valuedCost) : null;
  const mainCurrency = dominantCurrency(value);
  const returnValue = valueTwd === null ? value[mainCurrency] || 0 : valueTwd;
  const returnCost = valuedCostTwd === null ? valuedCost[mainCurrency] || 0 : valuedCostTwd;
  const returnPct = returnCost ? ((returnValue - returnCost) / returnCost) * 100 : null;
  const valueSub = [
    `${positions.length - missingQuotes} 檔已估值`,
    returnPct === null ? null : `報酬率 ${returnPct > 0 ? "+" : ""}${fmtNum(returnPct, 1)}%`,
  ]
    .filter(Boolean)
    .join(" · ");

  const grid = el("div", { class: "stat-grid" }, [
    statTile("目前市值", Object.keys(value).length ? tileValue(value) : "—", valueSub),
    statTile("持股成本", tileValue(cost), `${positions.length} 檔`),
    statTile(
      "未實現損益",
      Object.keys(unreal).length ? tileValue(unreal) : "—",
      missingQuotes ? `${missingQuotes} 檔沒有現價，未計入` : "已全部估值",
      tileClass(unreal)
    ),
    statTile(`${thisYear} 已實現`, tileValue(realizedYear), null, tileClass(realizedYear)),
    statTile("累計已實現", tileValue(realizedAll), `${lots.length} 筆平倉`, tileClass(realizedAll)),
    // 永豐配息沒有發放日期，無法歸到某一年，所以這裡用累計而不是年度，
    // 否則明明有幾十萬配息卻顯示「今年 NT$0」，會讓人以為資料沒同步到。
    statTile(
      "累計配息",
      tileValue(dividendTotal),
      brokerDividendCount
        ? `永豐 ${brokerDividendCount} 檔（無日期）· 手動 ${manualDividends.length} 筆`
        : `${manualDividends.length} 筆紀錄`
    ),
  ]);
  frag.appendChild(grid);

  if (crossCurrency) frag.appendChild(converted ? fxAppliedNote() : fxMissingNote());

  const recentRealized = lots.slice(0, 5);
  frag.appendChild(
    box(
      "最近平倉",
      recentRealized.length ? recentRealized.map(realizedRow) : filteredBlank("尚無平倉紀錄"),
      el("a", { href: "#/realized", text: "全部", class: "mono" })
    )
  );

  const recentManual = state.trades.filter(inMarket).slice(0, 3);
  if (recentManual.length) {
    frag.appendChild(
      box(
        "最近手動交易",
        recentManual.map(tradeRow),
        el("a", { href: "#/ledger", text: "全部", class: "mono" })
      )
    );
  }

  // 提醒不受市場鏡片影響（提醒頁本身也沒有市場篩選），這裡跟著保持完整清單
  const now = Date.now();
  const upcoming = state.events.filter((e) => e.eventDate.getTime() >= now - DAY_MS).slice(0, 5);
  frag.appendChild(
    box(
      "近期提醒",
      upcoming.length ? upcoming.map(eventRow) : blankslate("近期沒有除權息或財報日"),
      el("a", { href: "#/reminders", text: "全部", class: "mono" })
    )
  );

  return frag;
}

const brokerLabel = { sinopac: "永豐", schwab: "嘉信", manual: "手動" };

function tradeRow(t) {
  const amount = t.quantity * t.price;
  return el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [
        symbolLabel(t.symbol, t.market),
        el("span", { class: `label-pill ${t.side}`, text: t.side === "buy" ? "買" : "賣" }),
        t.note ? el("span", { class: "label-pill", text: "備註" }) : null,
      ]),
      el("div", {
        class: "row-sub",
        text: `${fmtDate(t.tradeDate)} · ${brokerLabel[t.broker] || t.broker} · ${fmtShares(t.quantity)} 股 @ ${fmtNum(t.price)}`,
      }),
    ]),
    el("div", { class: "row-right" }, [
      el("div", { class: "mono", text: fmtMoney(amount, t.currency) }),
      el("div", { class: "row-sub mono", text: `費 ${fmtNum(t.fee + t.tax, 0)}` }),
    ]),
  ]);
}

function eventRow(e) {
  const days = Math.ceil((e.eventDate.getTime() - Date.now()) / DAY_MS);
  return el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [
        symbolLabel(e.symbol, e.market),
        el("span", {
          class: `label-pill ${e.type === "earnings" ? "accent" : ""}`,
          text: e.type === "earnings" ? "財報" : "除權息",
        }),
      ]),
      el("div", { class: "row-sub", text: fmtDate(e.eventDate) }),
    ]),
    el("div", { class: "row-right mono muted", text: days <= 0 ? "今天" : `${days} 天` }),
  ]);
}

function positionRow(p) {
  const u = p.unrealizedPnl;
  const pct = u !== null && p.totalCost ? (u / p.totalCost) * 100 : null;

  const subs = [
    subLine([`${p.shares === null ? "—" : fmtShares(p.shares)} 股`, `均價 ${fmtNum(p.avgCost)}`]),
    subLine([
      `成本 ${fmtMoney(p.totalCost, p.currency)}`,
      p.marketValue === null ? null : `市值 ${fmtMoney(p.marketValue, p.currency)}`,
    ]),
  ];

  if (p.source === "sinopac" && (p.earliestEntryDate || p.exDividends)) {
    subs.push(
      subLine(
        [
          p.earliestEntryDate ? `最早進場 ${fmtDate(p.earliestEntryDate)}` : null,
          p.exDividends ? `累計配息 ${fmtMoney(p.exDividends, p.currency)}` : null,
        ],
        "row-sub"
      )
    );
  }

  // 只有永豐部位的現價是同步寫進來的，其餘（手動、嘉信匯入）都沒有自動來源，要能手填
  // 同步抓得到的現價顯示唯讀（手改了下次同步也會被蓋回去）；
  // 抓不到的（債券 CUSIP、下市股）與手填過的才給輸入框，讓使用者能自己填或改錯字。
  const quote = state.quotes[symbolKey(p.market, p.symbol)];
  const priceIsManual = !quote || quote.source === "manual";
  const priceNode =
    priceIsManual
      ? el("input", {
          class: "price-input mono",
          type: "number",
          step: "0.01",
          inputmode: "decimal",
          placeholder: "現價",
          value: p.lastPrice ? String(p.lastPrice) : "",
          onchange: (ev) => {
            const v = parseFloat(ev.target.value);
            if (!isNaN(v) && v > 0) saveQuote(p.market, p.symbol, v);
          },
        })
      : el("div", { class: "price-static mono", text: `現價 ${fmtNum(p.lastPrice)}` });

  // 現價與損益放在標題那一行的右側，明細行才能用滿整個寬度。
  // 之前現價是獨立的右欄，會把明細擠成每個詞一行、還出現落單的分隔點。
  return el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-head" }, [
        el("div", { class: "row-title" }, [
          symbolLabel(p.symbol, p.market),
          el("span", { class: "label-pill", text: p.market }),
          el("span", { class: `label-pill src-${p.source}`, text: SOURCE_LABEL[p.source] || p.source }),
          p.cond && p.cond !== "Cash"
            ? el("span", { class: "label-pill", text: COND_LABEL[p.cond] || p.cond })
            : null,
        ]),
        el("div", { class: "row-head-right" }, [
          priceNode,
          el("div", {
            class: `mono ${u === null ? "muted" : pnlClass(u)}`,
            text:
              u === null
                ? "—"
                : `${fmtMoney(u, p.currency)}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${fmtNum(pct, 1)}%)`}`,
          }),
        ]),
      ]),
      ...subs,
    ]),
  ]);
}

function viewPositions() {
  const positions = allPositions().filter(inMarket);
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  if (!positions.length) {
    frag.appendChild(box("持股庫存", filteredBlank("目前沒有持股")));
    return frag;
  }

  const missing = positions.filter((p) => p.source !== "sinopac" && p.marketValue === null);

  if (missing.length) {
    frag.appendChild(
      el("div", {
        class: "flash",
        text: `${missing.length} 檔部位缺現價，填入右側欄位才算得出未實現損益（永豐台股由同步自動寫入，美股沒有自動來源）。`,
      })
    );
  }
  frag.appendChild(box("持股庫存", positions.map(positionRow)));
  return frag;
}

const LEDGER_PAGE_SIZE = 10;
const LOT_STATUS_LABEL = { open: "持有中", closed: "已平倉" };

function ledgerRow(tx) {
  // 狀態、來源這類次要資訊放進 row-sub，標題只留三顆 pill，375px 下才不會折成兩行
  const parts = [fmtDate(tx.date)];
  if (tx.status) parts.push(LOT_STATUS_LABEL[tx.status]);
  // lots 是張數，零股一律回報 0，不能顯示成「0 張」讓人以為沒成交；數量以金額為準
  if (tx.lots > 0) parts.push(`${fmtNum(tx.lots, 0)} 張`);
  else if (tx.source === "sinopac") parts.push("零股");
  if (tx.shares !== null) parts.push(`${fmtShares(tx.shares)} 股`);
  if (tx.unitPrice) parts.push(`@ ${fmtNum(tx.unitPrice)}`);
  if (tx.costBasis !== null) parts.push(`成本 ${fmtMoney(tx.costBasis, tx.currency)}`);
  if (tx.fee) parts.push(`費 ${fmtNum(tx.fee, 0)}`);
  if (tx.holdingDays !== null) parts.push(`持有 ${tx.holdingDays} 天`);

  const right =
    tx.pnl === null
      ? [
          el("div", { class: "mono", text: fmtMoney(tx.amount, tx.currency) }),
          el("div", { class: "row-sub mono", text: tx.side === "buy" ? "成本" : "賣出金額" }),
        ]
      : [
          el("div", { class: `mono ${pnlClass(tx.pnl)}`, text: fmtMoney(tx.pnl, tx.currency) }),
          el("div", { class: "row-sub mono", text: "已實現" }),
        ];

  const row = el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [
        symbolLabel(tx.symbol, tx.market),
        el("span", { class: "label-pill", text: tx.market }),
        el("span", { class: `label-pill ${tx.side}`, text: tx.side === "buy" ? "買" : "賣" }),
        el("span", { class: `label-pill src-${tx.source}`, text: SOURCE_LABEL[tx.source] || tx.source }),
      ]),
      subLine(parts),
    ]),
    el("div", { class: "row-right" }, right),
  ]);

  if (tx.trade) {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => openTradeDetail(tx.trade));
  }
  return row;
}

function viewLedger() {
  const all = allTransactions().filter(inMarket);
  const years = [...new Set(all.map((t) => t.date.getFullYear()))].sort((a, b) => b - a);
  if (viewOptions.ledgerYear !== "all" && !years.includes(viewOptions.ledgerYear)) {
    viewOptions.ledgerYear = "all";
  }
  const year = viewOptions.ledgerYear;
  const month = viewOptions.ledgerMonth;

  const q = viewOptions.ledgerQuery.trim().toLowerCase();
  const matchesQuery = (t) =>
    !q ||
    t.symbol.toLowerCase().includes(q) ||
    symbolName(t.symbol, t.market).toLowerCase().includes(q);

  const filtered = all.filter(
    (t) =>
      (year === "all" || t.date.getFullYear() === year) &&
      (month === "all" || t.date.getMonth() + 1 === month) &&
      matchesQuery(t)
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / LEDGER_PAGE_SIZE));
  if (viewOptions.ledgerPage > pageCount) viewOptions.ledgerPage = pageCount;
  const page = viewOptions.ledgerPage;
  const shown = filtered.slice((page - 1) * LEDGER_PAGE_SIZE, page * LEDGER_PAGE_SIZE);

  const goPage = (n) => {
    viewOptions.ledgerPage = Math.min(pageCount, Math.max(1, n));
    render();
  };

  const pickYear = (ev) => {
    viewOptions.ledgerYear = ev.target.value === "all" ? "all" : Number(ev.target.value);
    viewOptions.ledgerPage = 1;
    render();
  };

  const pickMonth = (ev) => {
    viewOptions.ledgerMonth = ev.target.value === "all" ? "all" : Number(ev.target.value);
    viewOptions.ledgerPage = 1;
    render();
  };

  const yearSelect = el("select", { onchange: pickYear }, [
    el("option", { value: "all", text: "全部年度", ...(year === "all" ? { selected: "" } : {}) }),
    ...years.map((y) =>
      el("option", { value: String(y), text: `${y} 年`, ...(y === year ? { selected: "" } : {}) })
    ),
  ]);

  const monthSelect = el("select", { onchange: pickMonth }, [
    el("option", { value: "all", text: "全部月份", ...(month === "all" ? { selected: "" } : {}) }),
    ...Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
      el("option", { value: String(m), text: `${m} 月`, ...(m === month ? { selected: "" } : {}) })
    ),
  ]);

  const searchInput = el("input", {
    type: "search",
    placeholder: "搜尋代號或名稱，例如 2330、台積電、TSLA",
    value: viewOptions.ledgerQuery,
    oninput: (ev) => {
      viewOptions.ledgerQuery = ev.target.value;
      viewOptions.ledgerPage = 1;
      render();
      // 重繪會換掉節點，把焦點與游標位置放回去，不然打一個字就跳出輸入框
      const next = document.getElementById("ledgerSearch");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    },
    id: "ledgerSearch",
  });

  const filters = el("div", { class: "box-body" }, [
    el("div", { class: "field" }, [el("label", { text: "搜尋" }), searchInput]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field slim" }, [el("label", { text: "年度" }), yearSelect]),
      el("div", { class: "field slim" }, [el("label", { text: "月份" }), monthSelect]),
    ]),
    el("div", {
      class: "row-sub",
      text: "永豐的買進來自逐筆進場批次、賣出來自平倉紀錄；手動輸入的交易點一下可編輯備註或刪除。",
    }),
    ...(filtered.length && (q || year !== "all" || month !== "all")
      ? [deleteFilteredPanel(filtered, q)]
      : []),
  ]);

  const pager = el("div", { class: "pager" }, [
    el("button", {
      class: "btn btn-sm",
      text: "← 上一頁",
      ...(page <= 1 ? { disabled: "" } : {}),
      onclick: () => goPage(page - 1),
    }),
    el("span", {
      class: "mono muted",
      text: `第 ${page} / ${pageCount} 頁 · 共 ${filtered.length} 筆`,
    }),
    el("button", {
      class: "btn btn-sm",
      text: "下一頁 →",
      ...(page >= pageCount ? { disabled: "" } : {}),
      onclick: () => goPage(page + 1),
    }),
  ]);

  const addBtn = el("button", {
    class: "btn btn-sm btn-primary",
    text: "新增交易",
    onclick: () => toggleTradeForm(),
  });

  const importBtn = el("button", {
    class: "btn btn-sm",
    text: "匯入嘉信",
    onclick: () => document.getElementById("schwabFile").click(),
  });

  const headerActions = el("div", { style: "display:flex;gap:8px" }, [importBtn, addBtn]);

  const form = el("div", { class: "box-body hidden", id: "tradeForm" }, [buildTradeForm()]);
  const importPanel = el("div", { class: "box-body hidden", id: "importPanel" });
  const fileInput = el("input", {
    type: "file",
    id: "schwabFile",
    accept: ".json,application/json",
    class: "hidden",
    onchange: (ev) => handleSchwabFile(ev.target.files[0]),
  });

  const body = shown.length
    ? shown.map(ledgerRow)
    : [
        all.length
          ? blankslate("這個期間沒有交易紀錄", "換一個年度或月份試試")
          : filteredBlank("尚無交易紀錄", "永豐同步的買進批次與平倉紀錄，加上手動輸入的交易都會列在這裡"),
      ];

  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());
  frag.appendChild(
    box(
      "交易紀錄",
      [
        fileInput, filters, importPanel, form, ...body,
        ...(filtered.length ? [el("div", { class: "box-body" }, [pager])] : []),
      ],
      headerActions
    )
  );
  return frag;
}

async function handleSchwabFile(file) {
  const panel = document.getElementById("importPanel");
  if (!file || !panel) return;
  panel.classList.remove("hidden");
  panel.replaceChildren(el("div", { class: "row-sub", text: `讀取 ${file.name}…` }));

  let parsed;
  try {
    // 整份檔案只在瀏覽器裡解析，不會上傳到任何伺服器
    parsed = parseSchwabExport(JSON.parse(await file.text()), state.settings.ignoredSymbols || []);
  } catch (err) {
    panel.replaceChildren(
      el("div", { class: "flash", text: `這個檔案讀不出來：${err.message}。請確認是從嘉信網站「輸出交易數據」選 JSON 匯出的原始檔。` })
    );
    return;
  }
  renderImportPreview(panel, parsed, file.name);
}

function renderImportPreview(panel, parsed, filename) {
  const buys = parsed.trades.filter((t) => t.side === "buy").length;
  const income = parsed.dividends.filter((d) => d.kind !== "tax");
  const taxes = parsed.dividends.filter((d) => d.kind === "tax");
  const sum = (list) => list.reduce((s, d) => s + d.amount, 0);
  const closed = parsed.options.filter((o) => o.status !== "open");
  const stale = parsed.options.filter((o) => o.staleOpen);

  const rows = [
    ["買賣", `${parsed.trades.length} 筆`, `買 ${buys} · 賣 ${parsed.trades.length - buys}（含股利再投入的買進）`],
    ["股利/利息", `${income.length} 筆`, fmtMoney(sum(income), "USD", 2)],
    ["稅費", `${taxes.length} 筆`, `${fmtMoney(sum(taxes), "USD", 2)}（已從股利淨額扣除）`],
    ["選擇權合約", `${parsed.options.length} 個`, `已結束 ${closed.length} · 權利金 ${fmtMoney(closed.reduce((s, o) => s + o.realizedPnl, 0), "USD", 2)}`],
    ["忽略", `${parsed.ignored} 筆`, Object.entries(parsed.ignoredActions).map(([k, v]) => `${k} ${v}`).join("、")],
  ];

  const table = el("div", {}, rows.map(([label, value, note]) =>
    el("div", { class: "box-row", style: "padding:8px 0" }, [
      el("div", { class: "row-main" }, [
        el("div", { class: "row-title" }, [el("span", { text: label })]),
        el("div", { class: "row-sub", text: note }),
      ]),
      el("div", { class: "row-right mono", text: value }),
    ])
  ));

  const status = el("div", { class: "row-sub", style: "margin-top:10px" });

  const confirmBtn = el("button", {
    class: "btn btn-primary",
    text: "確認匯入",
    onclick: async () => {
      confirmBtn.disabled = true;
      try {
        const n = await importSchwab(parsed, (done, total) => {
          status.textContent = `寫入中… ${done} / ${total}`;
        });
        status.textContent = `完成，共寫入 ${n} 筆。重複匯入同一份不會產生重複資料。`;
        confirmBtn.remove();
      } catch (err) {
        status.textContent = `寫入失敗：${err.message}`;
        confirmBtn.disabled = false;
      }
    },
  });

  const children = [
    el("div", { class: "row-title", text: `匯入預覽：${filename}` }),
    el("div", { class: "row-sub", text: `${parsed.range.from} ~ ${parsed.range.to}，共 ${parsed.total} 列` }),
    table,
  ];

  if (stale.length) {
    children.push(el("div", {
      class: "flash",
      text: `${stale.length} 個合約已過到期日但匯出檔裡沒有結算紀錄，會標成「無結算紀錄」而不是當成現有部位。`,
    }));
  }
  if (parsed.unclassified.length) {
    children.push(el("div", { class: "flash", text: `${parsed.unclassified.length} 列無法辨識，不會匯入：` }));
    children.push(el("div", { class: "row-sub" },
      parsed.unclassified.slice(0, 10).map((u) =>
        el("div", { text: `${u.date} ${u.action} ${u.symbol} — ${u.why}` }))));
  }

  children.push(el("div", { style: "display:flex;gap:8px;margin-top:12px" }, [
    confirmBtn,
    el("button", { class: "btn", text: "取消", onclick: () => panel.classList.add("hidden") }),
  ]));
  children.push(status);

  panel.replaceChildren(...children);
}

// 搜尋/篩選出一批紀錄後，可以整批刪掉。刪除前先講清楚會動到哪些東西。
function deleteFilteredPanel(filtered, query) {
  const symbols = [...new Set(filtered.map((t) => t.symbol))];
  const markets = [...new Set(filtered.map((t) => t.market))];
  const wholeSymbol = query && symbols.length >= 1 && markets.length === 1;
  const status = el("div", { class: "row-sub", style: "margin-top:8px" });

  const ignoreBox = el("input", { type: "checkbox", checked: "", style: "width:auto;margin-right:6px" });
  const ignoreLabel = el("label", { style: "display:flex;align-items:center;font-weight:400" }, [
    ignoreBox,
    el("span", { text: `以後匯入時忽略 ${symbols.join("、")}（不然下次匯入會再長回來）` }),
  ]);

  const btn = el("button", {
    class: "btn btn-sm btn-danger",
    text: `刪除這 ${filtered.length} 筆`,
    onclick: async () => {
      const scope = wholeSymbol
        ? `${symbols.join("、")} 的所有紀錄（含買進批次、平倉、選擇權、股利、現價與名稱）`
        : `目前篩選出的 ${filtered.length} 筆交易`;
      if (!confirm(`確定要刪除 ${scope}？這個動作無法復原。`)) return;
      btn.disabled = true;
      try {
        const refs = wholeSymbol
          ? relatedDocRefs(symbols, markets[0])
          : filtered.filter((t) => t.kind === "trade").map((t) => myDoc("trades", t.id));
        const n = await deleteDocsInBatches(refs, (d, total) => {
          status.textContent = `刪除中… ${d} / ${total}`;
        });
        if (wholeSymbol && ignoreBox.checked) {
          const current = state.settings.ignoredSymbols || [];
          await setIgnoredSymbols([...new Set([...current, ...symbols])]);
        }
        status.textContent = `已刪除 ${n} 份文件。`;
        viewOptions.ledgerQuery = "";
        viewOptions.ledgerPage = 1;
      } catch (err) {
        status.textContent = `刪除失敗：${err.message}`;
        btn.disabled = false;
      }
    },
  });

  return el("div", { class: "flash", style: "margin-top:12px" }, [
    el("div", {
      text: wholeSymbol
        ? `符合「${query}」的有 ${symbols.join("、")}，共 ${filtered.length} 筆。`
        : `目前篩選出 ${filtered.length} 筆。只會刪掉交易紀錄本身，不會動到平倉或選擇權。`,
    }),
    wholeSymbol ? ignoreLabel : null,
    el("div", { style: "margin-top:8px" }, [btn]),
    status,
  ]);
}

/* ---------- 設定（開通名單） ---------- */

// 註冊是開放的，所以「誰能用」要另外管。這一頁只有擁有者看得到，
// 判斷在 firestore.rules，前端這層只是把結果畫出來。
function viewSettings() {
  if (!session.owner) {
    return el("div", { class: "blankslate", text: "這一頁只有擁有者能開。" });
  }

  const status = el("div", { class: "row-sub", style: "margin-top:8px" });
  const input = el("input", { type: "email", id: "allowEmail" });

  const addBtn = el("button", {
    class: "btn btn-sm btn-primary",
    text: "加入名單",
    onclick: async () => {
      const email = input.value.trim().toLowerCase();
      if (!email) return;
      addBtn.disabled = true;
      try {
        await setDoc(sharedDoc("allowlist", email), {
          addedAt: new Date().toISOString(),
          addedBy: session.email,
        });
        status.textContent = `已加入 ${email}，她現在可以自己註冊了。`;
        input.value = "";
      } catch (err) {
        status.textContent = `加入失敗：${err.message}`;
      }
      addBtn.disabled = false;
    },
  });

  const rows = state.allowlist.length
    ? state.allowlist.map((entry) =>
        el("div", { class: "row" }, [
          el("div", { class: "row-main" }, [
            el("div", { class: "mono", text: entry.email }),
            el("div", { class: "row-sub", text: entry.addedAt ? `加入於 ${entry.addedAt.slice(0, 10)}` : "" }),
          ]),
          entry.email === session.email
            ? el("span", { class: "row-sub", text: "你自己" })
            : el("button", {
                class: "btn btn-sm btn-danger",
                text: "移除",
                onclick: async () => {
                  if (!confirm(`移除 ${entry.email}？她會立刻無法讀取自己的資料，但資料本身不會被刪除。`)) return;
                  try {
                    await deleteDoc(sharedDoc("allowlist", entry.email));
                    status.textContent = `已移除 ${entry.email}。`;
                  } catch (err) {
                    status.textContent = `移除失敗：${err.message}`;
                  }
                },
              }),
        ])
      )
    : [el("div", { class: "blankslate", text: "名單是空的，只有你自己能用。" })];

  return el("div", {}, [
    el("div", { class: "box" }, [
      el("div", { class: "box-header", text: "開通名單" }),
      el("div", { class: "box-body" }, [
        el("div", { class: "row-sub" }, [
          "任何人都能在登入頁註冊帳號，但只有名單上的 Email 讀寫得到資料，其他人登入後會看到「尚未開通」。",
        ]),
        el("div", { class: "field", style: "margin-top:12px" }, [
          el("label", { text: "Email" }),
          input,
        ]),
        el("div", { style: "margin-top:8px" }, [addBtn]),
        status,
      ]),
    ]),
    el("div", { class: "box", style: "margin-top:12px" }, [
      el("div", { class: "box-header", text: `目前名單（${state.allowlist.length}）` }),
      ...rows,
    ]),
  ]);
}


function toggleTradeForm() {
  const f = document.getElementById("tradeForm");
  if (f) f.classList.toggle("hidden");
}

function buildTradeForm() {
  const today = new Date();
  const inputs = {};
  const field = (label, node) => el("div", { class: "field" }, [el("label", { text: label }), node]);

  inputs.symbol = el("input", { type: "text", placeholder: "2330 / AAPL", required: "" });
  inputs.market = el("select", {}, [
    el("option", { value: "TW", text: "台股 TW" }),
    el("option", { value: "US", text: "美股 US" }),
  ]);
  inputs.side = el("select", {}, [
    el("option", { value: "buy", text: "買進" }),
    el("option", { value: "sell", text: "賣出" }),
  ]);
  inputs.date = el("input", { type: "date", value: fmtDate(today) });
  inputs.quantity = el("input", { type: "number", step: "1", inputmode: "numeric", placeholder: "股數" });
  inputs.price = el("input", { type: "number", step: "0.0001", inputmode: "decimal", placeholder: "成交價" });
  inputs.fee = el("input", { type: "number", step: "0.01", inputmode: "decimal", placeholder: "0" });
  inputs.tax = el("input", { type: "number", step: "0.01", inputmode: "decimal", placeholder: "0" });
  inputs.note = el("textarea", { rows: "2", placeholder: "進出場理由、心得（選填）" });

  const submit = el("button", { class: "btn btn-primary", text: "儲存", type: "submit" });

  const form = el(
    "form",
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const market = inputs.market.value;
        const payload = {
          symbol: inputs.symbol.value.trim().toUpperCase(),
          market,
          side: inputs.side.value,
          quantity: Number(inputs.quantity.value) || 0,
          price: Number(inputs.price.value) || 0,
          fee: Number(inputs.fee.value) || 0,
          tax: Number(inputs.tax.value) || 0,
          currency: market === "US" ? "USD" : "TWD",
          tradeDate: new Date(inputs.date.value).toISOString(),
          note: inputs.note.value.trim(),
        };
        if (!payload.symbol || !payload.quantity || !payload.price) return;
        submit.disabled = true;
        await addManualTrade(payload);
        submit.disabled = false;
        inputs.symbol.value = "";
        inputs.quantity.value = "";
        inputs.price.value = "";
        inputs.fee.value = "";
        inputs.tax.value = "";
        inputs.note.value = "";
        toggleTradeForm();
      },
    },
    [
      el("div", { class: "field-row" }, [field("代號", inputs.symbol), field("市場", inputs.market)]),
      el("div", { class: "field-row" }, [field("買賣", inputs.side), field("日期", inputs.date)]),
      el("div", { class: "field-row" }, [field("股數", inputs.quantity), field("成交價", inputs.price)]),
      el("div", { class: "field-row" }, [field("手續費", inputs.fee), field("交易稅", inputs.tax)]),
      field("備註", inputs.note),
      submit,
    ]
  );

  return form;
}

function openTradeDetail(t) {
  const view = document.getElementById("view");
  const noteInput = el("textarea", { rows: "3", text: t.note, placeholder: "進出場理由、心得" });

  const saveBtn = el("button", {
    class: "btn btn-primary",
    text: "儲存備註",
    onclick: async () => {
      saveBtn.disabled = true;
      await saveTradeNote(t.id, noteInput.value.trim());
      saveBtn.disabled = false;
      location.hash = "#/ledger";
    },
  });

  const actions = [saveBtn, el("a", { class: "btn", href: "#/ledger", text: "返回" })];

  if (t.broker === "manual") {
    actions.push(
      el("button", {
        class: "btn btn-danger",
        text: "刪除",
        onclick: async () => {
          if (!confirm("刪除這筆手動紀錄？")) return;
          await deleteTrade(t.id);
          location.hash = "#/ledger";
        },
      })
    );
  }

  view.replaceChildren(
    box("交易明細", [
      el("div", { class: "box-body" }, [
        el("div", { class: "stat-grid" }, [
          statTile("代號", t.symbol, `${t.market} · ${brokerLabel[t.broker] || t.broker}`),
          statTile("買賣", t.side === "buy" ? "買進" : "賣出", fmtDate(t.tradeDate)),
          statTile("股數", fmtShares(t.quantity), `@ ${fmtNum(t.price)}`),
          statTile("成交金額", fmtMoney(t.quantity * t.price, t.currency), `費用 ${fmtNum(t.fee + t.tax, 0)}`),
        ]),
        el("div", { class: "field" }, [el("label", { text: "備註" }), noteInput]),
        t.broker !== "manual"
          ? el("div", { class: "row-sub", text: "同步來的紀錄只能編輯備註，其他欄位由券商資料為準。" })
          : null,
        el("div", { style: "display:flex;gap:8px;margin-top:12px" }, actions),
      ]),
    ])
  );
}

function realizedRow(l) {
  const parts = [fmtDate(l.sellDate)];
  if (l.quantity !== null) parts.push(`${fmtShares(l.quantity)} 股`);
  parts.push(`成本 ${fmtMoney(l.costBasis, l.currency)}`);
  if (l.proceeds !== null) parts.push(`收 ${fmtMoney(l.proceeds, l.currency)}`);
  else if (l.sellPrice) parts.push(`賣價 ${fmtNum(l.sellPrice)}`);
  if (l.exDividendAmt) parts.push(`配息 ${fmtMoney(l.exDividendAmt, l.currency)}`);

  return el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [
        symbolLabel(l.symbol, l.market),
        el("span", { class: "label-pill", text: l.market }),
        el("span", { class: `label-pill src-${l.source}`, text: SOURCE_LABEL[l.source] || l.source }),
      ]),
      subLine(parts),
    ]),
    el("div", { class: "row-right" }, [
      el("div", { class: `mono ${pnlClass(l.pnl)}`, text: fmtMoney(l.pnl, l.currency) }),
      el("div", {
        class: "row-sub mono",
        text: l.holdingDays === null ? "持有天數不明" : `持有 ${l.holdingDays} 天`,
      }),
    ]),
  ]);
}

function viewRealized() {
  const lots = allRealized().filter(inMarket);
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  if (!lots.length) {
    frag.appendChild(box("已實現損益", filteredBlank("尚無平倉紀錄")));
    return frag;
  }

  const total = sumByCurrency(lots, (l) => l.pnl);
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("累計已實現", fmtMultiLines(total), `${lots.length} 筆`, pnlClass(total[dominantCurrency(total)] || 0)),
    ])
  );

  frag.appendChild(box("已實現損益（已扣手續費與稅）", lots.map(realizedRow)));
  return frag;
}

function bucketKey(date, bucket) {
  const y = date.getFullYear();
  if (bucket === "year") return { key: `${y}`, label: `${y}` };
  if (bucket === "month") {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return { key: `${y}-${m}`, label: `${y % 100}/${m}` };
  }
  if (bucket === "week") {
    const d = new Date(date);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { key: fmtDate(d), label: `${d.getMonth() + 1}/${d.getDate()}` };
  }
  return { key: fmtDate(date), label: `${date.getMonth() + 1}/${date.getDate()}` };
}

function viewChart() {
  const lots = allRealized().filter(inMarket);
  // 預設選資料筆數最多的幣別，否則可能一進來就落在只有一筆的幣別而畫不出線。
  const counts = {};
  for (const l of lots) counts[l.currency] = (counts[l.currency] || 0) + 1;
  const currencies = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (!viewOptions.chartCurrency || !currencies.includes(viewOptions.chartCurrency)) {
    viewOptions.chartCurrency = currencies[0] || "TWD";
  }
  const currency = viewOptions.chartCurrency;
  const bucket = viewOptions.chartBucket;

  const relevant = lots.filter((l) => l.currency === currency);
  const buckets = new Map();
  for (const l of relevant) {
    const { key, label } = bucketKey(l.sellDate, bucket);
    if (!buckets.has(key)) buckets.set(key, { key, label, sum: 0 });
    buckets.get(key).sum += l.pnl;
  }

  const ordered = [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  let running = 0;
  const points = ordered.map((b) => {
    running += b.sum;
    return { label: b.label, value: running };
  });

  const controls = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
    segmented(
      [
        ["day", "日"],
        ["week", "週"],
        ["month", "月"],
        ["year", "年"],
      ],
      bucket,
      (v) => {
        viewOptions.chartBucket = v;
        render();
      }
    ),
    currencies.length > 1
      ? segmented(
          currencies.map((c) => [c, c]),
          currency,
          (v) => {
            viewOptions.chartCurrency = v;
            render();
          }
        )
      : null,
  ]);

  const body =
    points.length >= 2
      ? el("div", { class: "box-body" }, [
          el("div", { class: "chart-wrap" }, [lineChart(points, currency)]),
          el("div", {
            class: "row-sub",
            style: "margin-top:8px",
            text: `累計已實現損益（${currency}），依平倉日期分組`,
          }),
        ])
      : blankslate(
          points.length ? "資料點不足" : "尚無已實現損益",
          points.length ? "同一分組只有一個資料點，換成較小的分組單位試試" : "有平倉紀錄後才會出現走勢"
        );

  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());
  frag.appendChild(el("div", { class: "box" }, [el("div", { class: "box-body" }, [controls])]));
  frag.appendChild(box("損益走勢", body));
  return frag;
}

function viewExposure() {
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  const positions = allPositions().filter(inMarket);
  if (!positions.length) {
    frag.appendChild(box("持股曝險", filteredBlank("目前沒有持股")));
    return frag;
  }

  const exposureValue = (p) => p.marketValue ?? p.totalCost;
  const byCurrencyTotal = {};
  for (const p of positions) {
    byCurrencyTotal[p.currency] = (byCurrencyTotal[p.currency] || 0) + exposureValue(p);
  }
  const currencies = Object.keys(byCurrencyTotal).sort(
    (a, b) => byCurrencyTotal[b] - byCurrencyTotal[a]
  );

  // 有匯率才能把不同幣別畫進同一個圓餅；沒有匯率時比例會失真，維持一次只看一種幣別。
  const merged = currencies.length > 1 && sumTwd(byCurrencyTotal) !== null;
  if (!merged && !currencies.includes(viewOptions.exposureCurrency)) {
    viewOptions.exposureCurrency = currencies[0];
  }
  const currency = merged ? "TWD" : viewOptions.exposureCurrency;

  const mode = viewOptions.exposureMode;
  const totals = new Map();
  for (const p of positions) {
    if (!merged && p.currency !== currency) continue;
    const value = merged ? toTwd(exposureValue(p), p.currency) : exposureValue(p);
    const name = mode === "sector" ? sectorOf(p.symbol) : p.symbol;
    totals.set(name, (totals.get(name) || 0) + value);
  }

  const slices = [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const total = slices.reduce((s, x) => s + x.value, 0);

  const legend = el(
    "div",
    { class: "legend" },
    slices.map((s, i) =>
      el("div", { class: "legend-item" }, [
        el("span", {
          class: "swatch",
          style: `background:${DONUT_COLORS[i % DONUT_COLORS.length]}`,
        }),
        el("span", { class: "name", text: s.name }),
        el("span", { class: "mono muted", text: fmtMoney(s.value, currency) }),
        el("span", { class: "pct mono", text: `${fmtNum((s.value / total) * 100, 1)}%` }),
      ])
    )
  );

  const controls = segmented(
    [
      ["symbol", "個股"],
      ["sector", "產業"],
    ],
    mode,
    (v) => {
      viewOptions.exposureMode = v;
      render();
    }
  );

  if (!merged && currencies.length > 1) {
    frag.appendChild(
      el("div", { class: "box" }, [
        el("div", { class: "box-body" }, [
          segmented(
            currencies.map((c) => [c, c]),
            currency,
            (v) => {
              viewOptions.exposureCurrency = v;
              render();
            }
          ),
          el("div", {
            class: "row-sub",
            style: "margin-top:8px",
            text: "缺少 USD/TWD 匯率，無法把不同幣別放進同一個圓餅，先分幣別檢視。",
          }),
        ]),
      ])
    );
  }

  const sourceNote =
    "永豐部位用券商給的市值，手動部位有填現價才用市值，其餘用成本。產業對照表在 web/app.js 的 SECTORS，可自行擴充。";
  const scopeNote = merged
    ? `已把美股按 1 USD = ${fmtMoney(usdTwdRate(), "TWD", 3)} 換算成台幣後合併計算。`
    : `以 ${currency} 計價的部位。`;

  frag.appendChild(
    box("持股曝險比例", [
      el("div", { class: "box-body" }, [donutChart(slices), legend]),
      el("div", {
        class: "box-body",
        style: "border-top:1px solid var(--border-muted)",
      }, [
        el("div", { class: "row-sub", text: `${scopeNote}${sourceNote}` }),
      ]),
    ], controls)
  );
  return frag;
}

function viewStats() {
  const lots = allRealized().filter(inMarket);
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  if (!lots.length) {
    frag.appendChild(box("交易統計", filteredBlank("尚無平倉紀錄", "統計需要至少一筆已實現損益")));
    return frag;
  }

  const wins = lots.filter((l) => l.pnl > 0);
  const losses = lots.filter((l) => l.pnl < 0);
  const winRate = (wins.length / lots.length) * 100;
  const avgWin = wins.length ? wins.reduce((s, l) => s + l.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, l) => s + l.pnl, 0) / losses.length) : 0;
  const ratio = avgLoss ? avgWin / avgLoss : null;
  // 只採計真的有持有天數的紀錄，算不出來的不列入分母，也不補估計值
  const withDays = lots.filter((l) => l.holdingDays !== null);
  const missingDays = lots.length - withDays.length;
  const avgDays = withDays.length ? withDays.reduce((s, l) => s + l.holdingDays, 0) / withDays.length : null;
  const currency = dominantCurrency(sumByCurrency(lots, (l) => l.pnl));

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("勝率", `${fmtNum(winRate, 1)}%`, `${wins.length} 勝 / ${losses.length} 敗`),
      statTile("盈虧比", ratio === null ? "—" : fmtNum(ratio, 2), "平均獲利 ÷ 平均虧損"),
      statTile(
        "平均持有天數",
        avgDays === null ? "—" : fmtNum(avgDays, 1),
        avgDays === null
          ? `${lots.length} 筆都沒有持有天數`
          : `以 ${withDays.length}/${lots.length} 筆計算${missingDays ? `，${missingDays} 筆無天數未計入` : ""}`
      ),
      statTile("平均獲利", fmtMoney(avgWin, currency), null, "gain"),
      statTile("平均虧損", fmtMoney(-avgLoss, currency), null, "loss"),
      statTile("總平倉筆數", String(lots.length)),
    ])
  );

  // 同一代號在台美股都可能出現，幣別不同不能相加，所以用 market:symbol 當 key
  const bySymbol = new Map();
  for (const l of lots) {
    const key = `${l.market}:${l.symbol}`;
    if (!bySymbol.has(key)) {
      bySymbol.set(key, { symbol: l.symbol, market: l.market, currency: l.currency, pnl: 0, n: 0, w: 0 });
    }
    const s = bySymbol.get(key);
    s.pnl += l.pnl;
    s.n++;
    if (l.pnl > 0) s.w++;
  }
  const rows = [...bySymbol.values()]
    .sort((a, b) => b.pnl - a.pnl)
    .map((s) =>
      el("div", { class: "box-row" }, [
        el("div", { class: "row-main" }, [
          el("div", { class: "row-title" }, [
            symbolLabel(s.symbol, s.market),
            el("span", { class: "label-pill", text: s.market }),
          ]),
          el("div", { class: "row-sub", text: `${s.n} 筆 · 勝率 ${fmtNum((s.w / s.n) * 100, 0)}%` }),
        ]),
        el("div", { class: `row-right mono ${pnlClass(s.pnl)}`, text: fmtMoney(s.pnl, s.currency) }),
      ])
    );

  frag.appendChild(box("個股績效", rows));
  return frag;
}

function viewDividends() {
  const brokerTotals = brokerDividendTotals().filter(inMarket);
  const dividends = state.dividends.filter(inMarket);
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  if (!dividends.length && !brokerTotals.length) {
    frag.appendChild(box("股利紀錄", filteredBlank("尚無股利紀錄", "同步腳本寫入後會顯示在這裡")));
    return frag;
  }

  const byYear = new Map();
  for (const d of dividends) {
    const y = d.payDate.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(d);
  }

  const total = sumByCurrency(dividends, (d) => d.amount);
  const brokerTotal = sumByCurrency(brokerTotals, (s) => s.amount);
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("手動紀錄股利", fmtMultiLines(total), `${dividends.length} 筆`),
      brokerTotals.length
        ? statTile("永豐累計配息", fmtMultiLines(brokerTotal), `${brokerTotals.length} 檔 · 無發放日期`)
        : null,
    ].filter(Boolean))
  );

  if (brokerTotals.length) {
    frag.appendChild(
      box(
        "永豐配息（累計金額）",
        [
          el("div", { class: "box-body" }, [
            el("div", {
              class: "row-sub",
              text: "永豐沒有股利查詢 API，這裡是庫存與平倉紀錄裡的累計配息金額，沒有個別發放日期，也無法拆成單筆。",
            }),
          ]),
          ...brokerTotals.map((s) => {
            const parts = [];
            if (s.holding) parts.push(`持有中 ${fmtMoney(s.holding, s.currency)}`);
            if (s.closed) parts.push(`已平倉 ${fmtMoney(s.closed, s.currency)}`);
            return el("div", { class: "box-row" }, [
              el("div", { class: "row-main" }, [
                el("div", { class: "row-title" }, [
                  symbolLabel(s.symbol, s.market),
                  el("span", { class: "label-pill", text: s.market }),
                  el("span", { class: "label-pill src-sinopac", text: "永豐" }),
                ]),
                subLine(parts),
              ]),
              el("div", { class: "row-right mono gain", text: fmtMoney(s.amount, s.currency, 0) }),
            ]);
          }),
        ],
        el("span", { class: "mono muted", text: fmtMulti(brokerTotal) })
      )
    );
  }

  for (const [year, list] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    const yearTotal = sumByCurrency(list, (d) => d.amount);
    frag.appendChild(
      box(
        `${year} 年（有發放日期）`,
        list.map((d) =>
          el("div", { class: "box-row" }, [
            el("div", { class: "row-main" }, [
              el("div", { class: "row-title" }, [
                symbolLabel(d.symbol, d.market),
                el("span", { class: "label-pill", text: d.market }),
              ]),
              el("div", {
                class: "row-sub",
                text: `${fmtDate(d.payDate)}${d.shares ? ` · ${fmtNum(d.shares, 0)} 股` : ""}`,
              }),
            ]),
            el("div", { class: "row-right mono gain", text: fmtMoney(d.amount, d.currency, 0) }),
          ])
        ),
        el("span", { class: "mono muted", text: fmtMulti(yearTotal) })
      )
    );
  }
  return frag;
}

function viewReminders() {
  const now = Date.now();
  const upcoming = state.events.filter((e) => e.eventDate.getTime() >= now - DAY_MS);
  if (!upcoming.length)
    return box("提醒", blankslate("近期沒有除權息或財報日", "由 calendar_sync.py 每日更新"));

  const groups = { week: [], month: [], later: [] };
  for (const e of upcoming) {
    const days = (e.eventDate.getTime() - now) / DAY_MS;
    if (days <= 7) groups.week.push(e);
    else if (days <= 30) groups.month.push(e);
    else groups.later.push(e);
  }

  const frag = document.createDocumentFragment();
  const titles = { week: "7 天內", month: "30 天內", later: "更晚" };
  for (const k of ["week", "month", "later"]) {
    if (groups[k].length) frag.appendChild(box(titles[k], groups[k].map(eventRow)));
  }
  return frag;
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildReportCsv(year) {
  const lots = allRealized();
  const yearLots = lots.filter((l) => l.sellDate.getFullYear() === year);
  const yearDividends = state.dividends.filter((d) => d.payDate.getFullYear() === year);

  const lines = [];
  lines.push(`已實現損益 ${year}`);
  lines.push(
    [
      "平倉日期",
      "來源",
      "代號",
      "市場",
      "幣別",
      "股數",
      "成本",
      "賣出收入",
      "賣出均價",
      "已實現損益",
      "持有天數",
      "期間配息",
    ].join(",")
  );
  for (const l of yearLots) {
    lines.push(
      [
        fmtDate(l.sellDate),
        SOURCE_LABEL[l.source] || l.source,
        l.symbol,
        l.market,
        l.currency,
        l.quantity ?? "",
        l.costBasis.toFixed(2),
        l.proceeds === null ? "" : l.proceeds.toFixed(2),
        l.sellPrice === null ? "" : l.sellPrice.toFixed(4),
        l.pnl.toFixed(2),
        l.holdingDays ?? "",
        l.exDividendAmt ? l.exDividendAmt.toFixed(2) : "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const realizedTotal = sumByCurrency(yearLots, (l) => l.pnl);
  lines.push("");
  for (const [c, v] of Object.entries(realizedTotal)) lines.push(`已實現損益合計 (${c}),${v.toFixed(2)}`);

  lines.push("");
  lines.push(`股利 ${year}`);
  lines.push(["發放日", "代號", "市場", "幣別", "金額"].join(","));
  for (const d of yearDividends) {
    lines.push([fmtDate(d.payDate), d.symbol, d.market, d.currency, d.amount.toFixed(2)].map(csvEscape).join(","));
  }
  const divTotal = sumByCurrency(yearDividends, (d) => d.amount);
  lines.push("");
  for (const [c, v] of Object.entries(divTotal)) lines.push(`股利合計 (${c}),${v.toFixed(2)}`);

  if (brokerDividendTotals().length) {
    lines.push("");
    lines.push("永豐配息只有累計金額、沒有發放日期，無法歸屬年度，未列入本表");
  }

  return lines.join("\n");
}

function viewReport() {
  const lots = allRealized();
  const years = [
    ...new Set([
      ...lots.map((l) => l.sellDate.getFullYear()),
      ...state.dividends.map((d) => d.payDate.getFullYear()),
      new Date().getFullYear(),
    ]),
  ].sort((a, b) => b - a);

  if (!viewOptions.reportYear || !years.includes(viewOptions.reportYear)) {
    viewOptions.reportYear = years[0];
  }
  const year = viewOptions.reportYear;

  const select = el(
    "select",
    {
      onchange: (ev) => {
        viewOptions.reportYear = Number(ev.target.value);
        render();
      },
    },
    years.map((y) => el("option", { value: String(y), text: `${y} 年`, ...(y === year ? { selected: "" } : {}) }))
  );

  const csv = buildReportCsv(year);
  const filename = `stock-journal-${year}.csv`;
  const status = el("div", { class: "row-sub", style: "margin-top:8px" });

  const shareBtn = el("button", {
    class: "btn btn-primary",
    text: "匯出 CSV",
    onclick: async () => {
      // 在 iOS 主畫面模式下 <a download> 通常無效，優先用 Web Share
      const file = new File([`﻿${csv}`], filename, { type: "text/csv" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          return;
        } catch (err) {
          if (err.name === "AbortError") return;
        }
      }
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv" }));
      const a = el("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "若沒有跳出下載，請用下方的複製功能。";
    },
  });

  const copyBtn = el("button", {
    class: "btn",
    text: "複製內容",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(csv);
        status.textContent = "已複製到剪貼簿。";
      } catch {
        status.textContent = "複製失敗，請手動選取下方文字。";
      }
    },
  });

  const yearLots = lots.filter((l) => l.sellDate.getFullYear() === year);
  const realizedTotal = sumByCurrency(yearLots, (l) => l.pnl);
  const divTotal = sumByCurrency(
    state.dividends.filter((d) => d.payDate.getFullYear() === year),
    (d) => d.amount
  );

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile(
        `${year} 已實現損益`,
        fmtMultiLines(realizedTotal),
        `${yearLots.length} 筆平倉`,
        pnlClass(realizedTotal[dominantCurrency(realizedTotal)] || 0)
      ),
      statTile(`${year} 股利`, fmtMultiLines(divTotal)),
    ])
  );

  frag.appendChild(
    box("年度報表", [
      el("div", { class: "box-body" }, [
        el("div", { class: "field" }, [el("label", { text: "年度" }), select]),
        el("div", { style: "display:flex;gap:8px" }, [shareBtn, copyBtn]),
        status,
      ]),
      el("div", { class: "box-body", style: "border-top:1px solid var(--border-muted)" }, [
        el("textarea", { rows: "10", readonly: "", class: "mono", style: "font-size:12px", text: csv }),
      ]),
    ])
  );
  return frag;
}

/* ---------- router ---------- */

const OPTION_STATUS_LABEL = { open: "未平倉", expired: "到期作廢", assigned: "被指派", closed: "已平倉" };

function optionRow(o) {
  const days = o.expiry
    ? Math.ceil((new Date(`${o.expiry}T00:00:00`).getTime() - Date.now()) / DAY_MS)
    : null;
  const parts = [
    `${o.side === "short" ? "賣出" : "買進"} ${fmtNum(o.contracts, 0)} 口`,
    `履約 ${fmtNum(o.strike)}`,
    `到期 ${o.expiry}`,
  ];
  if (o.openDate) parts.push(`開倉 ${o.openDate}`);
  if (o.closeDate) parts.push(`${OPTION_STATUS_LABEL[o.status]} ${o.closeDate}`);
  if (o.status === "open" && !o.staleOpen && days !== null) parts.push(`剩 ${days} 天`);

  return el("div", { class: "box-row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-head" }, [
        el("div", { class: "row-title" }, [
          symbolLabel(o.underlying, o.market),
          el("span", { class: `label-pill ${o.kind === "P" ? "sell" : "buy"}`, text: o.kind === "P" ? "賣權" : "買權" }),
          o.staleOpen ? el("span", { class: "label-pill", text: "無結算紀錄" }) : null,
        ]),
        el("div", { class: "row-head-right" }, [
          el("div", {
            class: `mono ${o.realizedPnl === null ? "muted" : pnlClass(o.realizedPnl)}`,
            text: o.realizedPnl === null ? fmtMoney(o.premium, o.currency, 2) : fmtMoney(o.realizedPnl, o.currency, 2),
          }),
          el("div", { class: "row-sub", text: o.realizedPnl === null ? "權利金（未結算）" : OPTION_STATUS_LABEL[o.status] }),
        ]),
      ]),
      subLine(parts),
    ]),
  ]);
}

function viewOptionsScreen() {
  // 選擇權都是美股，台股視角下不該出現
  const all = viewOptions.market === "TW" ? [] : state.options;
  const frag = document.createDocumentFragment();
  frag.appendChild(marketBar());

  if (!all.length) {
    frag.appendChild(box("選擇權", filteredBlank("尚無選擇權紀錄", "從交易紀錄頁匯入嘉信的交易數據後會出現在這裡")));
    return frag;
  }

  const open = all.filter((o) => o.status === "open" && !o.staleOpen);
  const stale = all.filter((o) => o.staleOpen);
  const closed = all.filter((o) => o.status !== "open");
  const premium = closed.reduce((s, o) => s + (o.realizedPnl || 0), 0);
  const wins = closed.filter((o) => (o.realizedPnl || 0) > 0).length;

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("已結算權利金", fmtMoney(premium, "USD", 2), `${closed.length} 個合約`, pnlClass(premium)),
      statTile("未平倉", String(open.length), open.length ? "見下方到期日" : "目前沒有"),
      statTile("到期作廢比例", closed.length ? `${fmtNum((wins / closed.length) * 100, 0)}%` : "—", "權利金留下的比例"),
    ])
  );

  if (open.length) frag.appendChild(box("未平倉合約", open.map(optionRow)));
  if (closed.length) frag.appendChild(box("已結算", closed.map(optionRow)));
  if (stale.length) {
    frag.appendChild(
      box("無結算紀錄", [
        el("div", { class: "box-body" }, [
          el("div", {
            class: "row-sub",
            text: "這些合約已過到期日，但匯出檔裡找不到結算紀錄（通常是匯出區間沒涵蓋到）。沒有把它們當成現有部位，權利金也沒計入已結算金額。",
          }),
        ]),
        ...stale.map(optionRow),
      ])
    );
  }
  return frag;
}

const ROUTES = {
  "/": viewDashboard,
  "/positions": viewPositions,
  "/ledger": viewLedger,
  "/options": viewOptionsScreen,
  "/realized": viewRealized,
  "/chart": viewChart,
  "/exposure": viewExposure,
  "/stats": viewStats,
  "/dividends": viewDividends,
  "/reminders": viewReminders,
  "/report": viewReport,
  "/settings": viewSettings,
};

// 手動交易頁已併進交易紀錄，舊的 #/trades 連結與書籤繼續有效
const ROUTE_ALIASES = { "/trades": "/ledger" };

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const route = ROUTE_ALIASES[hash] || hash;
  return ROUTES[route] ? route : "/";
}

function render() {
  if (!state.ready) return;
  const route = currentRoute();
  for (const a of document.querySelectorAll(".tabnav a")) {
    a.classList.toggle("active", a.dataset.route === route);
  }
  const view = document.getElementById("view");
  view.replaceChildren(ROUTES[route]());
}

function renderSyncBadge() {
  const badge = document.getElementById("syncBadge");
  if (!badge) return;
  if (!state.syncMeta.length) {
    badge.textContent = "尚未同步";
    return;
  }
  const latest = state.syncMeta
    .filter((m) => m.lastSyncAt)
    .sort((a, b) => b.lastSyncAt - a.lastSyncAt)[0];
  const failed = state.syncMeta.filter((m) => !m.lastSuccess).map((m) => m.id);
  const when = latest ? fmtDate(latest.lastSyncAt) : "—";
  badge.textContent = failed.length ? `${when} · ${failed.join("/")} 失敗` : `同步 ${when}`;
}

/* ---------- theme ---------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute("content", theme === "dark" ? "#161b22" : "#24292f");
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* private mode */
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("theme");
  } catch {
    /* ignore */
  }
  const preferred =
    saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(preferred);
  document.getElementById("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });
}

/* ---------- auth + boot ---------- */

const AUTH_ERRORS = {
  "auth/invalid-email": "Email 格式不正確",
  "auth/invalid-credential": "帳號或密碼錯誤",
  "auth/wrong-password": "帳號或密碼錯誤",
  "auth/user-not-found": "找不到這個帳號",
  "auth/email-already-in-use": "這個 Email 已經註冊過了，改用登入即可",
  "auth/weak-password": "密碼至少要 6 個字",
  "auth/too-many-requests": "嘗試次數過多，稍後再試",
  "auth/network-request-failed": "網路連線失敗",
  "auth/operation-not-allowed": "Firebase 尚未啟用 Email/密碼登入",
};

// 註冊是開放的，任何人都能建 Firebase 帳號，所以「登入成功」不等於「可以用」。
// 真正的授權是 email 有沒有被列進 allowlist，而且判斷在 firestore.rules：
// 這個函式只是把結果反映到畫面上，改前端不會讓任何人多拿到一分權限。
async function checkAllowed(user) {
  // 擁有者永遠通過，不然名單被自己清空就沒人能再加人了
  if (user.uid === OWNER_UID) return true;
  if (!user.email) return false;
  try {
    const snap = await getDoc(sharedDoc("allowlist", user.email.toLowerCase()));
    return snap.exists();
  } catch {
    // 規則拒絕讀取時一樣當成沒開通
    return false;
  }
}

// 同步腳本從 users 集合列出所有使用者，才知道要幫誰抓現價與代號名稱。
// 沒有這份 document，她的持股就不會被共用的行情同步涵蓋到。
async function ensureProfile(user) {
  try {
    await setDoc(
      doc(db, "users", user.uid),
      { email: user.email, lastSeenAt: new Date().toISOString() },
      { merge: true }
    );
  } catch {
    /* 寫不進去不影響瀏覽自己的資料，下次登入再試 */
  }
}

function initAuth() {
  const gate = document.getElementById("authGate");
  const form = document.getElementById("authForm");
  const errorBox = document.getElementById("authError");
  const submitBtn = document.getElementById("authSubmit");
  const modeBtn = document.getElementById("authModeBtn");
  const modeHint = document.getElementById("authModeHint");
  const pendingBox = document.getElementById("authPending");
  const pendingEmail = document.getElementById("authPendingEmail");
  const settingsTab = document.querySelector('[data-route="/settings"]');

  let mode = "signin";

  function applyMode() {
    const signup = mode === "signup";
    submitBtn.textContent = signup ? "註冊" : "登入";
    modeBtn.textContent = signup ? "已經有帳號了？改用登入" : "第一次使用？註冊帳號";
    modeHint.textContent = signup
      ? "密碼至少 6 個字。註冊完如果看到「尚未開通」，請擁有者把你的 Email 加進開通名單。"
      : "";
    document.getElementById("authPassword").autocomplete = signup ? "new-password" : "current-password";
    errorBox.classList.add("hidden");
  }

  modeBtn.addEventListener("click", () => {
    mode = mode === "signup" ? "signin" : "signup";
    applyMode();
  });
  applyMode();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorBox.classList.add("hidden");
    submitBtn.disabled = true;
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      errorBox.textContent = AUTH_ERRORS[err.code] || `${mode === "signup" ? "註冊" : "登入"}失敗：${err.code || err.message}`;
      errorBox.classList.remove("hidden");
    }
    submitBtn.disabled = false;
  });

  for (const id of ["signOutBtn", "authPendingSignOut"]) {
    document.getElementById(id).addEventListener("click", () => signOut(auth));
  }

  onAuthStateChanged(auth, async (user) => {
    // 換帳號時先把前一個人的監聽全部收掉並清空 state，
    // 不然舊監聽會掛在別人的路徑上一直噴 permission-denied，資料也會殘留在畫面上
    unsubscribeAll();
    session.uid = user ? user.uid : null;
    session.email = user ? user.email : null;
    session.owner = !!user && user.uid === OWNER_UID;
    session.allowed = user ? await checkAllowed(user) : false;

    // 登入流程是非同步的，等 await 回來時使用者可能已經登出或換人，
    // 這時候這一輪的結果就過期了，不能拿去改畫面
    if (auth.currentUser !== user) return;

    const active = !!user && session.allowed;
    gate.classList.toggle("hidden", !!user);
    pendingBox.classList.toggle("hidden", !user || session.allowed);
    document.getElementById("topbar").classList.toggle("hidden", !active);
    document.getElementById("view").classList.toggle("hidden", !active);
    if (settingsTab) settingsTab.classList.toggle("hidden", !session.owner);

    if (user && !session.allowed) {
      pendingEmail.textContent = user.email || "";
    }

    if (active) {
      state.ready = true;
      ensureProfile(user);
      subscribe();
      render();
    }
    if (!user) {
      document.getElementById("authPassword").value = "";
      mode = "signin";
      applyMode();
    }
  });
}

window.addEventListener("hashchange", render);

initTheme();
initAuth();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* 離線快取失敗不影響主要功能 */
    });
  });
}
