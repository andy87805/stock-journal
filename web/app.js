import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

const state = {
  trades: [],
  dividends: [],
  events: [],
  quotes: {},
  syncMeta: [],
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

// 不同幣別不做匯率換算（沒有免費可靠的匯率來源），各自獨立顯示。
const fmtMultiLines = (byCurrency, digits = 0) => {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => Math.abs(v) > 0.0001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([c, v]) => fmtMoney(v, c, digits));
  return parts.length ? parts : [fmtMoney(0, "TWD")];
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
      positions.push({ symbol, market, currency, shares, avgCost, openedAt });
    }
  }

  positions.sort((a, b) => b.shares * b.avgCost - a.shares * a.avgCost);
  lots.sort((a, b) => b.sellDate - a.sellDate);
  return { positions, lots };
}

const marketValue = (p) => {
  const q = state.quotes[`${p.market}:${p.symbol}`];
  return q && q.price ? p.shares * q.price : null;
};

const unrealized = (p) => {
  const mv = marketValue(p);
  return mv === null ? null : mv - p.shares * p.avgCost;
};

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

function subscribe() {
  onSnapshot(collection(db, "trades"), (snap) => {
    state.trades = snap.docs.map((d) => normalizeTrade(d.id, d.data()));
    state.trades.sort((a, b) => b.tradeDate - a.tradeDate);
    render();
  });

  onSnapshot(collection(db, "dividends"), (snap) => {
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
  });

  onSnapshot(collection(db, "calendarEvents"), (snap) => {
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
  });

  onSnapshot(collection(db, "quotes"), (snap) => {
    const q = {};
    for (const d of snap.docs) {
      const v = d.data();
      q[d.id] = { price: Number(v.price) || 0, updatedAt: parseDate(v.updatedAt) };
    }
    state.quotes = q;
    render();
  });

  onSnapshot(collection(db, "syncMeta"), (snap) => {
    state.syncMeta = snap.docs.map((d) => ({
      id: d.id,
      lastSyncAt: parseDate(d.data().lastSyncAt),
      lastSuccess: d.data().lastSuccess !== false,
      lastError: d.data().lastError || "",
    }));
    renderSyncBadge();
  });
}

async function saveQuote(market, symbol, price) {
  await setDoc(
    doc(db, "quotes", `${market}:${symbol}`),
    { symbol, market, price, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

async function saveTradeNote(id, note) {
  await updateDoc(doc(db, "trades", id), { note });
}

async function addManualTrade(data) {
  const id = `manual_${Date.now()}`;
  await setDoc(doc(db, "trades", id), {
    ...data,
    broker: "manual",
    externalId: id,
    syncedAt: new Date().toISOString(),
  });
}

async function deleteTrade(id) {
  await deleteDoc(doc(db, "trades", id));
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

/* ---------- views ---------- */

const viewOptions = {
  chartBucket: "month",
  chartCurrency: null,
  exposureMode: "symbol",
  exposureCurrency: null,
  reportYear: null,
};

function viewDashboard() {
  const { positions, lots } = computeBook(state.trades);
  const frag = document.createDocumentFragment();

  const cost = sumByCurrency(positions, (p) => p.shares * p.avgCost);
  const unreal = {};
  let missingQuotes = 0;
  for (const p of positions) {
    const u = unrealized(p);
    if (u === null) missingQuotes++;
    else unreal[p.currency] = (unreal[p.currency] || 0) + u;
  }
  const realizedAll = sumByCurrency(lots, (l) => l.realizedPnL);
  const thisYear = new Date().getFullYear();
  const realizedYear = sumByCurrency(
    lots.filter((l) => l.sellDate.getFullYear() === thisYear),
    (l) => l.realizedPnL
  );
  const dividendYear = sumByCurrency(
    state.dividends.filter((d) => d.payDate.getFullYear() === thisYear),
    (d) => d.amount
  );

  const grid = el("div", { class: "stat-grid" }, [
    statTile("持股成本", fmtMultiLines(cost), `${positions.length} 檔`),
    statTile(
      "未實現損益",
      Object.keys(unreal).length ? fmtMultiLines(unreal) : "—",
      missingQuotes ? `${missingQuotes} 檔未填現價` : "已全部估值",
      pnlClass(unreal[dominantCurrency(unreal)] || 0)
    ),
    statTile(
      `${thisYear} 已實現`,
      fmtMultiLines(realizedYear),
      null,
      pnlClass(realizedYear[dominantCurrency(realizedYear)] || 0)
    ),
    statTile(
      "累計已實現",
      fmtMultiLines(realizedAll),
      `${lots.length} 筆平倉`,
      pnlClass(realizedAll[dominantCurrency(realizedAll)] || 0)
    ),
    statTile(`${thisYear} 股利`, fmtMultiLines(dividendYear), `${state.dividends.length} 筆紀錄`),
  ]);
  frag.appendChild(grid);

  const recent = state.trades.slice(0, 5);
  frag.appendChild(
    box(
      "最近交易",
      recent.length
        ? recent.map(tradeRow)
        : blankslate("尚無交易紀錄", "等待同步腳本寫入，或手動新增一筆"),
      el("a", { href: "#/trades", text: "全部", class: "mono" })
    )
  );

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
        el("span", { class: "mono", text: t.symbol }),
        el("span", { class: `label-pill ${t.side}`, text: t.side === "buy" ? "買" : "賣" }),
        t.note ? el("span", { class: "label-pill", text: "備註" }) : null,
      ]),
      el("div", {
        class: "row-sub",
        text: `${fmtDate(t.tradeDate)} · ${brokerLabel[t.broker] || t.broker} · ${fmtNum(t.quantity, 0)} 股 @ ${fmtNum(t.price)}`,
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
        el("span", { class: "mono", text: e.symbol }),
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

function viewPositions() {
  const { positions } = computeBook(state.trades);
  if (!positions.length) return box("持股庫存", blankslate("目前沒有持股"));

  const rows = positions.map((p) => {
    const key = `${p.market}:${p.symbol}`;
    const q = state.quotes[key];
    const u = unrealized(p);
    const costTotal = p.shares * p.avgCost;
    const pct = u !== null && costTotal ? (u / costTotal) * 100 : null;

    const priceInput = el("input", {
      class: "price-input mono",
      type: "number",
      step: "0.01",
      inputmode: "decimal",
      placeholder: "現價",
      value: q && q.price ? String(q.price) : "",
      onchange: (ev) => {
        const v = parseFloat(ev.target.value);
        if (!isNaN(v) && v > 0) saveQuote(p.market, p.symbol, v);
      },
    });

    return el("div", { class: "box-row" }, [
      el("div", { class: "row-main" }, [
        el("div", { class: "row-title" }, [
          el("span", { class: "mono", text: p.symbol }),
          el("span", { class: "label-pill", text: p.market }),
        ]),
        el("div", {
          class: "row-sub mono",
          text: `${fmtNum(p.shares, 0)} 股 · 均價 ${fmtNum(p.avgCost)}`,
        }),
        el("div", { class: "row-sub mono", text: `成本 ${fmtMoney(costTotal, p.currency)}` }),
      ]),
      el("div", { class: "row-right" }, [
        priceInput,
        el("div", {
          class: `mono ${u === null ? "muted" : pnlClass(u)}`,
          text: u === null ? "—" : `${fmtMoney(u, p.currency)}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${fmtNum(pct, 1)}%)`}`,
        }),
      ]),
    ]);
  });

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el("div", {
      class: "flash",
      text: "未實現損益需要現價：在右側欄位填入即可，會存進 Firestore 跨裝置共用。",
    })
  );
  frag.appendChild(box("持股庫存", rows));
  return frag;
}

function viewTrades() {
  const frag = document.createDocumentFragment();

  const addBtn = el("button", {
    class: "btn btn-sm btn-primary",
    text: "新增交易",
    onclick: () => toggleTradeForm(),
  });

  const form = el("div", { class: "box-body hidden", id: "tradeForm" }, [buildTradeForm()]);

  const list = state.trades.length
    ? state.trades.map(tradeRowInteractive)
    : [blankslate("尚無交易紀錄", "永豐同步會自動寫入，美股目前請手動新增")];

  const b = box("交易紀錄", [form, ...list], addBtn);
  frag.appendChild(b);
  return frag;
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

function tradeRowInteractive(t) {
  const row = tradeRow(t);
  row.style.cursor = "pointer";
  row.addEventListener("click", () => openTradeDetail(t));
  return row;
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
      location.hash = "#/trades";
    },
  });

  const actions = [saveBtn, el("a", { class: "btn", href: "#/trades", text: "返回" })];

  if (t.broker === "manual") {
    actions.push(
      el("button", {
        class: "btn btn-danger",
        text: "刪除",
        onclick: async () => {
          if (!confirm("刪除這筆手動紀錄？")) return;
          await deleteTrade(t.id);
          location.hash = "#/trades";
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
          statTile("股數", fmtNum(t.quantity, 0), `@ ${fmtNum(t.price)}`),
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

function viewRealized() {
  const { lots } = computeBook(state.trades);
  if (!lots.length) return box("已實現損益", blankslate("尚無平倉紀錄"));

  const total = sumByCurrency(lots, (l) => l.realizedPnL);
  const frag = document.createDocumentFragment();
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("累計已實現", fmtMultiLines(total), `${lots.length} 筆`, pnlClass(total[dominantCurrency(total)] || 0)),
    ])
  );

  const rows = lots.map((l) =>
    el("div", { class: "box-row" }, [
      el("div", { class: "row-main" }, [
        el("div", { class: "row-title" }, [
          el("span", { class: "mono", text: l.symbol }),
          el("span", { class: "label-pill", text: l.market }),
        ]),
        el("div", {
          class: "row-sub mono",
          text: `${fmtDate(l.sellDate)} · ${fmtNum(l.quantity, 0)} 股 · 成本 ${fmtMoney(l.costBasis, l.currency)} → 收 ${fmtMoney(l.proceeds, l.currency)}`,
        }),
      ]),
      el("div", { class: "row-right" }, [
        el("div", { class: `mono ${pnlClass(l.realizedPnL)}`, text: fmtMoney(l.realizedPnL, l.currency) }),
        el("div", {
          class: "row-sub mono",
          text: l.holdingDays === null ? "—" : `持有 ${l.holdingDays} 天`,
        }),
      ]),
    ])
  );

  frag.appendChild(box("已實現損益（已扣手續費與稅）", rows));
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
  const { lots } = computeBook(state.trades);
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
    buckets.get(key).sum += l.realizedPnL;
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
  frag.appendChild(el("div", { class: "box" }, [el("div", { class: "box-body" }, [controls])]));
  frag.appendChild(box("損益走勢", body));
  return frag;
}

function viewExposure() {
  const { positions } = computeBook(state.trades);
  if (!positions.length) return box("持股曝險", blankslate("目前沒有持股"));

  // 不同幣別不能加在同一個圓餅裡（沒有匯率換算，比例會失真），一次只看一種幣別。
  const byCurrencyCount = {};
  for (const p of positions) {
    const v = marketValue(p) ?? p.shares * p.avgCost;
    byCurrencyCount[p.currency] = (byCurrencyCount[p.currency] || 0) + v;
  }
  const currencies = Object.keys(byCurrencyCount).sort(
    (a, b) => byCurrencyCount[b] - byCurrencyCount[a]
  );
  if (!viewOptions.exposureCurrency || !currencies.includes(viewOptions.exposureCurrency)) {
    viewOptions.exposureCurrency = currencies[0];
  }
  const currency = viewOptions.exposureCurrency;

  const mode = viewOptions.exposureMode;
  const totals = new Map();
  for (const p of positions.filter((p) => p.currency === currency)) {
    const value = marketValue(p) ?? p.shares * p.avgCost;
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

  const frag = document.createDocumentFragment();
  if (currencies.length > 1) {
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
        ]),
      ])
    );
  }
  frag.appendChild(
    box("持股曝險比例", [
      el("div", { class: "box-body" }, [donutChart(slices), legend]),
      el("div", {
        class: "box-body",
        style: "border-top:1px solid var(--border-muted)",
      }, [
        el("div", {
          class: "row-sub",
          text: `以 ${currency} 計價的部位（不同幣別不換算匯率，分開檢視）。有填現價的用市值，其餘用成本。產業對照表在 web/app.js 的 SECTORS，可自行擴充。`,
        }),
      ]),
    ], controls)
  );
  return frag;
}

function viewStats() {
  const { lots } = computeBook(state.trades);
  if (!lots.length) return box("交易統計", blankslate("尚無平倉紀錄", "統計需要至少一筆已實現損益"));

  const wins = lots.filter((l) => l.realizedPnL > 0);
  const losses = lots.filter((l) => l.realizedPnL < 0);
  const winRate = (wins.length / lots.length) * 100;
  const avgWin = wins.length ? wins.reduce((s, l) => s + l.realizedPnL, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, l) => s + l.realizedPnL, 0) / losses.length) : 0;
  const ratio = avgLoss ? avgWin / avgLoss : null;
  const withDays = lots.filter((l) => l.holdingDays !== null);
  const avgDays = withDays.length ? withDays.reduce((s, l) => s + l.holdingDays, 0) / withDays.length : null;
  const currency = dominantCurrency(sumByCurrency(lots, (l) => l.realizedPnL));

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("勝率", `${fmtNum(winRate, 1)}%`, `${wins.length} 勝 / ${losses.length} 敗`),
      statTile("盈虧比", ratio === null ? "—" : fmtNum(ratio, 2), "平均獲利 ÷ 平均虧損"),
      statTile("平均持有天數", avgDays === null ? "—" : fmtNum(avgDays, 1), `${withDays.length} 筆可計算`),
      statTile("平均獲利", fmtMoney(avgWin, currency), null, "gain"),
      statTile("平均虧損", fmtMoney(-avgLoss, currency), null, "loss"),
      statTile("總平倉筆數", String(lots.length)),
    ])
  );

  const bySymbol = new Map();
  for (const l of lots) {
    if (!bySymbol.has(l.symbol)) bySymbol.set(l.symbol, { symbol: l.symbol, currency: l.currency, pnl: 0, n: 0, w: 0 });
    const s = bySymbol.get(l.symbol);
    s.pnl += l.realizedPnL;
    s.n++;
    if (l.realizedPnL > 0) s.w++;
  }
  const rows = [...bySymbol.values()]
    .sort((a, b) => b.pnl - a.pnl)
    .map((s) =>
      el("div", { class: "box-row" }, [
        el("div", { class: "row-main" }, [
          el("div", { class: "row-title" }, [el("span", { class: "mono", text: s.symbol })]),
          el("div", { class: "row-sub", text: `${s.n} 筆 · 勝率 ${fmtNum((s.w / s.n) * 100, 0)}%` }),
        ]),
        el("div", { class: `row-right mono ${pnlClass(s.pnl)}`, text: fmtMoney(s.pnl, s.currency) }),
      ])
    );

  frag.appendChild(box("個股績效", rows));
  return frag;
}

function viewDividends() {
  if (!state.dividends.length)
    return box("股利紀錄", blankslate("尚無股利紀錄", "同步腳本寫入後會顯示在這裡"));

  const byYear = new Map();
  for (const d of state.dividends) {
    const y = d.payDate.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(d);
  }

  const frag = document.createDocumentFragment();
  const total = sumByCurrency(state.dividends, (d) => d.amount);
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      statTile("累計股利", fmtMultiLines(total), `${state.dividends.length} 筆`),
    ])
  );

  for (const [year, list] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    const yearTotal = sumByCurrency(list, (d) => d.amount);
    frag.appendChild(
      box(
        `${year} 年`,
        list.map((d) =>
          el("div", { class: "box-row" }, [
            el("div", { class: "row-main" }, [
              el("div", { class: "row-title" }, [
                el("span", { class: "mono", text: d.symbol }),
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
  const { lots } = computeBook(state.trades);
  const yearLots = lots.filter((l) => l.sellDate.getFullYear() === year);
  const yearDividends = state.dividends.filter((d) => d.payDate.getFullYear() === year);

  const lines = [];
  lines.push(`已實現損益 ${year}`);
  lines.push(["平倉日期", "代號", "市場", "幣別", "股數", "成本", "賣出收入", "已實現損益", "持有天數"].join(","));
  for (const l of yearLots) {
    lines.push(
      [
        fmtDate(l.sellDate),
        l.symbol,
        l.market,
        l.currency,
        l.quantity,
        l.costBasis.toFixed(2),
        l.proceeds.toFixed(2),
        l.realizedPnL.toFixed(2),
        l.holdingDays ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const realizedTotal = sumByCurrency(yearLots, (l) => l.realizedPnL);
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

  return lines.join("\n");
}

function viewReport() {
  const { lots } = computeBook(state.trades);
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
  const realizedTotal = sumByCurrency(yearLots, (l) => l.realizedPnL);
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

const ROUTES = {
  "/": viewDashboard,
  "/positions": viewPositions,
  "/trades": viewTrades,
  "/realized": viewRealized,
  "/chart": viewChart,
  "/exposure": viewExposure,
  "/stats": viewStats,
  "/dividends": viewDividends,
  "/reminders": viewReminders,
  "/report": viewReport,
};

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return ROUTES[hash] ? hash : "/";
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
  "auth/too-many-requests": "嘗試次數過多，稍後再試",
  "auth/network-request-failed": "網路連線失敗",
  "auth/operation-not-allowed": "Firebase 尚未啟用 Email/密碼登入",
};

function initAuth() {
  const gate = document.getElementById("authGate");
  const form = document.getElementById("authForm");
  const errorBox = document.getElementById("authError");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorBox.classList.add("hidden");
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      errorBox.textContent = AUTH_ERRORS[err.code] || `登入失敗：${err.code || err.message}`;
      errorBox.classList.remove("hidden");
    }
  });

  document.getElementById("signOutBtn").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, (user) => {
    const signedIn = !!user;
    gate.classList.toggle("hidden", signedIn);
    document.getElementById("appHeader").classList.toggle("hidden", !signedIn);
    document.getElementById("tabnav").classList.toggle("hidden", !signedIn);
    document.getElementById("view").classList.toggle("hidden", !signedIn);
    if (signedIn && !state.ready) {
      state.ready = true;
      subscribe();
      render();
    }
    if (!signedIn) {
      document.getElementById("authPassword").value = "";
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
