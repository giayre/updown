// ====== ENV / CONFIG ======
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Nguồn dữ liệu: "auto" | "paprika" | "gecko"
const DATA_SOURCE = (process.env.DATA_SOURCE ?? "auto").toLowerCase();

// Ngưỡng %
const UP_THRESHOLD   = toNum(process.env.UP_THRESHOLD,   100);
const DOWN_THRESHOLD = toNum(process.env.DOWN_THRESHOLD,  -40);

// Lọc thanh khoản
const MIN_VOLUME_24H = toNum(process.env.MIN_VOLUME_24H, 2000000); // USD
const SHOW_VOLUME    = (process.env.SHOW_VOLUME ?? "false") === "true";

// Lọc Market Cap
const MIN_MARKET_CAP  = toNum(process.env.MIN_MARKET_CAP, 0);   // USD
const MAX_MARKET_CAP  = toNum(process.env.MAX_MARKET_CAP, 0);   // 0 = không giới hạn trên
const SHOW_MARKET_CAP = (process.env.SHOW_MARKET_CAP ?? "false") === "true";

// Cách gửi
const SEND_PER_COIN = (process.env.SEND_PER_COIN ?? "false") === "true";

// Icon
const UP_ICON   = process.env.UP_ICON   ?? "🟢⬆️";
const DOWN_ICON = process.env.DOWN_ICON ?? "🔻";

// Giới hạn số lượng
const MAX_ITEMS_PER_RUN = toNum(process.env.MAX_ITEMS_PER_RUN, 60);
const MAX_DOWN_ITEMS    = toNum(process.env.MAX_DOWN_ITEMS,    MAX_ITEMS_PER_RUN);
const MAX_UP_ITEMS      = toNum(process.env.MAX_UP_ITEMS,      MAX_ITEMS_PER_RUN);

// CoinGecko params (nếu dùng)
const GECKO_PAGES      = toNum(process.env.GECKO_PAGES,      1);
const GECKO_PER_PAGE   = toNum(process.env.GECKO_PER_PAGE,   250);
const GECKO_BACKOFF_MS = toNum(process.env.GECKO_BACKOFF_MS, 1200);

// ====== DEDUP ======
const STATE_PATH = process.env.STATE_PATH ?? ".state/alerts_state.json";
const RESEND_DELTA_UP   = toNum(process.env.RESEND_DELTA_UP,   5); // gửi lại nếu vượt thêm X %p
const RESEND_DELTA_DOWN = toNum(process.env.RESEND_DELTA_DOWN, 5);
const STATE_RETENTION_DAYS = toNum(process.env.STATE_RETENTION_DAYS, 0); // 0 = không dọn
const DEBUG_DEDUP = (process.env.DEBUG_DEDUP ?? "false") === "true";

// ===== Helpers =====
const fs = require("fs");
const path = require("path");

function toNum(v, def){ const n = Number(v); return Number.isFinite(n) ? n : def; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fmtPrice(n){
  const x = Number(n);
  return !Number.isFinite(x) ? String(n) :
    (x >= 1 ? x.toFixed(4) : x.toPrecision(8)).replace(/\.?0+$/,"");
}
function fmtUSD(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  if (x >= 1e12) return (x/1e12).toFixed(2) + "T";
  if (x >= 1e9)  return (x/1e9 ).toFixed(2) + "B";
  if (x >= 1e6)  return (x/1e6 ).toFixed(2) + "M";
  if (x >= 1e3)  return (x/1e3 ).toFixed(2) + "K";
  return x.toFixed(0);
}
function nowVN(){
  const tz = "Asia/Ho_Chi_Minh";
  const d  = new Date();
  return {
    d:  d.toLocaleDateString("vi-VN", { timeZone: tz }),
    hm: d.toLocaleTimeString("vi-VN", { timeZone: tz, hour: "2-digit", minute: "2-digit" })
  };
}
function dateVNISO(){
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date()); // YYYY-MM-DD
}
function pctStr(p){ return (p >= 0 ? `+${p.toFixed(2)}%` : `${p.toFixed(2)}%`); }

// ===== Fetchers =====
async function fetchPaprika(){
  const r = await fetch("https://api.coinpaprika.com/v1/tickers?quotes=USD",
    { headers: { "User-Agent":"Mozilla/5.0" }});
  if (!r.ok) throw new Error(`paprika HTTP ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error("paprika bad format");
  return arr.map(x => ({
    symbol: String(x.symbol || "").toUpperCase(),
    price:  Number(x?.quotes?.USD?.price),
    pct24h: Number(x?.quotes?.USD?.percent_change_24h),
    vol24:  Number(x?.quotes?.USD?.volume_24h),
    mcap:   Number(x?.quotes?.USD?.market_cap)
  }));
}
async function fetchGecko(pages=1, perPage=250){
  const out = [];
  for (let page=1; page<=pages; page++){
    const url = `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=24h`;
    const r = await fetch(url, { headers: { "User-Agent":"Mozilla/5.0" }});
    if (r.status === 429) throw new Error("gecko 429");
    if (!r.ok) throw new Error(`gecko HTTP ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    arr.forEach(x => out.push({
      symbol: String(x.symbol || "").toUpperCase(),
      price:  Number(x.current_price),
      pct24h: Number(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h),
      vol24:  Number(x.total_volume),
      mcap:   Number(x.market_cap)
    }));
    if (page < pages) await sleep(GECKO_BACKOFF_MS);
  }
  return out;
}

// ===== State =====
function loadState(){
  try {
    if (STATE_PATH && fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
  } catch {}
  return {};
}
function saveState(obj){
  if (!STATE_PATH) return;
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

// ===== Telegram =====
async function sendTelegram(text){
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",                  // in đậm
      disable_web_page_preview: true
    })
  });
  if (!r.ok) throw new Error(`telegram HTTP ${r.status}`);
}

// ===== Main =====
async function run(){
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID env");
  }

  // --- lấy dữ liệu ---
  let items = [];
  try {
    if (DATA_SOURCE === "paprika") {
      items = await fetchPaprika();
    } else if (DATA_SOURCE === "gecko") {
      items = await fetchGecko(GECKO_PAGES, GECKO_PER_PAGE);
    } else { // auto
      try { items = await fetchGecko(GECKO_PAGES, GECKO_PER_PAGE); }
      catch { items = await fetchPaprika(); }
    }
  } catch (e) {
    console.error("Data fetch error:", e?.message || e);
    return;
  }
  if (!items || !items.length) return;

  const { d, hm } = nowVN();
  const dateKey = dateVNISO();

  // --- state theo ngày VN + dọn ngày cũ ---
  const state = loadState();
  if (STATE_RETENTION_DAYS > 0) {
    const today = new Date(dateKey);
    for (const k of Object.keys(state)) {
      const diffDays = (today - new Date(k)) / 86400000;
      if (Number.isFinite(diffDays) && diffDays > STATE_RETENTION_DAYS) {
        delete state[k];
      }
    }
  }
  if (!state[dateKey]) state[dateKey] = {};

  const ups = [], downs = [];

  for (const it of items){
    const symbol = String(it.symbol || "").toUpperCase();
    const price  = Number(it.price);
    const pct24  = Number(it.pct24h);
    const vol24  = Number(it.vol24);
    const mcap   = Number(it.mcap);

    if (!symbol || !Number.isFinite(price) || !Number.isFinite(pct24)) continue;

    // lọc volume
    if (MIN_VOLUME_24H > 0) {
      if (!Number.isFinite(vol24) || vol24 < MIN_VOLUME_24H) continue;
    }
    // lọc MC
    if (MIN_MARKET_CAP > 0) {
      if (!Number.isFinite(mcap) || mcap < MIN_MARKET_CAP) continue;
    }
    if (MAX_MARKET_CAP > 0) {
      if (Number.isFinite(mcap) && mcap > MAX_MARKET_CAP) continue;
    }

    const s = state[dateKey][symbol] || { up:null, down:null };
    if (DEBUG_DEDUP) console.log(`[dedup] ${symbol} prevUp=${s.up} prevDown=${s.down} now=${pct24.toFixed(2)}`);

    // GIẢM: gửi khi giảm sâu hơn mốc cũ ít nhất RESEND_DELTA_DOWN
    if (pct24 <= DOWN_THRESHOLD) {
      if (s.down === null || pct24 <= s.down - RESEND_DELTA_DOWN) {
        downs.push({ symbol, price, pct:pct24, vol:vol24, mcap });
        state[dateKey][symbol] = { ...s, down: (s.down === null ? pct24 : Math.min(s.down, pct24)) };
      }
    }
    // TĂNG: gửi khi cao hơn mốc cũ ít nhất RESEND_DELTA_UP
    if (pct24 >= UP_THRESHOLD) {
      if (s.up === null || pct24 >= s.up + RESEND_DELTA_UP) {
        ups.push({ symbol, price, pct:pct24, vol:vol24, mcap });
        state[dateKey][symbol] = { ...(state[dateKey][symbol] || s), up: (s.up === null ? pct24 : Math.max(s.up, pct24)) };
      }
    }
  }

  // ===== GỬI TIN (GIẢM trước, TĂNG sau) =====
  let changed = false;

  if (SEND_PER_COIN){
    let downSent = 0, upSent = 0;

    for (const h of downs.sort((a,b)=>a.pct-b.pct)){
      if (downSent >= MAX_DOWN_ITEMS) break;
      const bits = [];
      if (SHOW_VOLUME)     bits.push(`Vol 24h: ${fmtUSD(h.vol)} USD`);
      if (SHOW_MARKET_CAP) bits.push(`MC: ${fmtUSD(h.mcap)} USD`);
      const extra = bits.length ? ` — ${bits.join(" | ")}` : "";
      const msg = `${DOWN_ICON} <b>${h.symbol}</b> đã giảm ${h.pct.toFixed(2)}% trong ngày ${d} tính đến ${hm}\n` +
                  `Giá hiện tại: ${fmtPrice(h.price)} USD${extra}`;
      await sendTelegram(msg);
      downSent++; changed = true; await sleep(200);
    }

    for (const h of ups.sort((a,b)=>b.pct-a.pct)){
      if (upSent >= MAX_UP_ITEMS) break;
      const bits = [];
      if (SHOW_VOLUME)     bits.push(`Vol 24h: ${fmtUSD(h.vol)} USD`);
      if (SHOW_MARKET_CAP) bits.push(`MC: ${fmtUSD(h.mcap)} USD`);
      const extra = bits.length ? ` — ${bits.join(" | ")}` : "";
      const msg = `${UP_ICON} <b>${h.symbol}</b> đã tăng +${h.pct.toFixed(2)}% trong ngày ${d} tính đến ${hm}\n` +
                  `Giá hiện tại: ${fmtPrice(h.price)} USD${extra}`;
      await sendTelegram(msg);
      upSent++; changed = true; await sleep(200);
    }
  } else {
    const lines = [];
    let downCount = 0, upCount = 0;

    if (downs.length){
      lines.push(`${DOWN_ICON} Giảm ≤ ${Math.abs(DOWN_THRESHOLD)}% (tính đến ${hm} ${d})`);
      for (const h of downs.sort((a,b)=>a.pct-b.pct)){
        if (downCount >= MAX_DOWN_ITEMS) break;
        const bits = [];
        if (SHOW_VOLUME)     bits.push(`Vol 24h: ${fmtUSD(h.vol)} USD`);
        if (SHOW_MARKET_CAP) bits.push(`MC: ${fmtUSD(h.mcap)} USD`);
        const extra = bits.length ? ` — ${bits.join(" | ")}` : "";
        lines.push(`${DOWN_ICON} <b>${h.symbol}</b> ${pctStr(h.pct)} — ${fmtPrice(h.price)} USD${extra}`);
        downCount++;
      }
    }
    if (ups.length){
      if (lines.length) lines.push("");
      lines.push(`${UP_ICON} Tăng ≥ ${UP_THRESHOLD}% (tính đến ${hm} ${d})`);
      for (const h of ups.sort((a,b)=>b.pct-a.pct)){
        if (upCount >= MAX_UP_ITEMS) break;
        const bits = [];
        if (SHOW_VOLUME)     bits.push(`Vol 24h: ${fmtUSD(h.vol)} USD`);
        if (SHOW_MARKET_CAP) bits.push(`MC: ${fmtUSD(h.mcap)} USD`);
        const extra = bits.length ? ` — ${bits.join(" | ")}` : "";
        lines.push(`${UP_ICON} <b>${h.symbol}</b> ${pctStr(h.pct)} — ${fmtPrice(h.price)} USD${extra}`);
        upCount++;
      }
    }
    if (downCount + upCount > 0){
      await sendTelegram(lines.join("\n"));
      changed = true;
    }
  }

  if (changed) saveState(state); // tạo/ghi file state để commit ở step tiếp theo
}

// chạy
run().catch(err => console.error("ERR:", err?.message || err));
