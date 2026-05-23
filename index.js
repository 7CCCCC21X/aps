"use strict";

const http = require("http");
const fs = require("fs");

// ── 1. 固定项目列表 ──────────────────────────────────────────────
const PROJECTS = [
  "GAEA",
  "Citrea",
  "XMAQUINA",
  "Nexus",
  "Cap",
  "predict.fun",
  "Grvt",
  "Arcium",
  "Veera",
  "Extended",
  "Reya",
  "StandX",
  "Variational",
  "Concrete",
  "TermMax",
  "Printr",
  "Theo",
  "Puffpaw",
];

const ASPECTA_API = "https://trade.aspecta.ai/api/hermes/trading/k-line";
const ASSETS_API = "https://trade.aspecta.ai/api/hermes/trading/assets-list";

// ── 配置（环境变量 + 运行时可改）────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// 可选：群组话题(forum topic)的 message_thread_id，提醒会发到该话题
const TOPIC_ID = (() => {
  const v = parseInt(process.env.TELEGRAM_TOPIC_ID, 10);
  return Number.isFinite(v) ? v : null;
})();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// 冷却作用域：project=同项目任意原因共用一个冷却（默认，减少刷屏）；type=本轮/24H 各自独立
const COOLDOWN_SCOPE = process.env.COOLDOWN_SCOPE === "type" ? "type" : "project";

// 有权执行“写”类命令（订阅/暂停/改阈值等）的 Telegram 用户 id；为空表示不限制
const ADMIN_USER_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_USER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

// 持久化文件路径（订阅 + 运行时设置）。指向 Railway Volume 可跨重新部署保留
const DATA_FILE = process.env.DATA_FILE || "./data.json";

// 即将上市（pre_launch）项目监控
const TRADING_CONFIG_ID = process.env.TRADING_CONFIG_ID || "1";
const UPCOMING_ENABLED = process.env.UPCOMING_ENABLED !== "false";
const UPCOMING_INTERVAL_SEC = (() => {
  const v = parseInt(process.env.UPCOMING_INTERVAL_SEC, 10);
  return Number.isFinite(v) && v >= 60 ? v : 300;
})();
const LAUNCH_SOON_MIN = (() => {
  const v = parseInt(process.env.LAUNCH_SOON_MIN, 10);
  return Number.isFinite(v) && v >= 1 ? v : 60;
})();

function intEnv(name, def, min) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min ? v : def;
}
function floatEnv(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

const dayPctDefault = floatEnv("DAY_ALERT_PERCENT", 5);
const settings = {
  pollIntervalSec: intEnv("POLL_INTERVAL_SEC", 60, 10),
  pollAlertPercent: floatEnv("POLL_ALERT_PERCENT", 1),
  dayAlertPercent: dayPctDefault,
  // 24H 回滞：触发用 dayAlertPercent，回落到 dayRearmPercent 内才允许再次触发
  dayRearmPercent: floatEnv("DAY_REARM_PERCENT", Math.max(0, dayPctDefault - 1)),
  cooldownMin: intEnv("ALERT_COOLDOWN_MIN", 30, 0),
  // 本轮变化的回看窗口（秒）。0 = 对比上一次轮询；>0 = 对比约 N 秒前的价格
  pollLookbackSec: intEnv("POLL_LOOKBACK_SEC", 0, 0),
  paused: false,
};

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 运行时状态
const priceHistory = new Map(); // project -> [{ t, price }]（按时间升序）
const lastPollChange = new Map(); // project -> 上一轮变化%
const alertCooldown = new Map(); // `${project}:${type}` -> 时间戳
const dayState = new Map(); // project -> 24H 区间状态：1 / 0 / -1（用于边沿触发）
const subscriptions = new Map(); // key -> { chatId, threadId }；提醒会发到这些目标
const knownUpcoming = new Map(); // name -> { startAt, canTrade, notifiedSoon }

function subKey(chatId, threadId) {
  return `${chatId}:${threadId == null ? "general" : threadId}`;
}
function addSubscription(chatId, threadId) {
  const tid = threadId == null ? null : Number(threadId);
  subscriptions.set(subKey(chatId, tid), { chatId, threadId: tid });
}
function removeSubscription(chatId, threadId) {
  return subscriptions.delete(subKey(chatId, threadId == null ? null : Number(threadId)));
}
// 用环境变量里的 CHAT_ID/TOPIC_ID 作为持久的默认订阅（重启后仍在）
function seedSubscriptions() {
  if (CHAT_ID) addSubscription(CHAT_ID, TOPIC_ID);
}

// ── 持久化（订阅 + 运行时设置）──────────────────────────────────
const PERSISTED_SETTINGS = [
  "pollIntervalSec",
  "pollAlertPercent",
  "dayAlertPercent",
  "dayRearmPercent",
  "cooldownMin",
  "pollLookbackSec",
  "paused",
];

function saveState() {
  try {
    const data = {
      subscriptions: [...subscriptions.values()],
      settings: Object.fromEntries(
        PERSISTED_SETTINGS.map((k) => [k, settings[k]]),
      ),
    };
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE); // 原子替换
  } catch (e) {
    console.error("[state] 保存失败:", e.message);
  }
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch {
    return; // 文件不存在，跳过
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data.settings === "object") {
      for (const k of PERSISTED_SETTINGS) {
        if (data.settings[k] != null) settings[k] = data.settings[k];
      }
    }
    if (data && Array.isArray(data.subscriptions)) {
      for (const s of data.subscriptions) {
        if (s && s.chatId != null) addSubscription(s.chatId, s.threadId);
      }
    }
    console.log(`[state] 已从 ${DATA_FILE} 恢复（订阅 ${subscriptions.size}）`);
  } catch (e) {
    console.error("[state] 读取失败:", e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 工具函数 ────────────────────────────────────────────────────
function toPrice(value) {
  // 价格为 18 位定点整数。纯整数字符串用字符串拼小数再转 Number，
  // 避免大整数（>2^53）先转 double 再除导致的精度损失。
  if (value == null) return null;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) {
    const neg = s.startsWith("-");
    const digits = (neg ? s.slice(1) : s).padStart(19, "0");
    const intPart = digits.slice(0, -18) || "0";
    const fracPart = digits.slice(-18);
    return (neg ? -1 : 1) * Number(`${intPart}.${fracPart}`);
  }
  return Number(s) / 1e18;
}

function pct(current, base) {
  if (base == null || base === 0 || !isFinite(base)) return null;
  return ((current - base) / base) * 100;
}

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return "N/A";
  const a = Math.abs(p);
  if (a === 0) return "0";
  if (a >= 1) return p.toFixed(4);
  if (a >= 0.0001) return p.toFixed(6);
  return p.toPrecision(4);
}

function fmtPct(x) {
  if (x == null || !isFinite(x)) return "N/A";
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 把话题 id 合并进 sendMessage 的附加参数，让消息发到指定 forum topic
function threadExtra(threadId, extra = {}) {
  if (threadId != null && Number.isFinite(Number(threadId))) {
    extra.message_thread_id = Number(threadId);
  }
  return extra;
}

// ── 2 & 3. 请求接口并解析 K 线 ──────────────────────────────────
async function fetchSnapshot(retries = 1) {
  const url = new URL(ASPECTA_API);
  url.searchParams.set("project_address", PROJECTS.join(","));
  url.searchParams.set("offset", PROJECTS.map(() => "24").join(","));
  url.searchParams.set("window_type", PROJECTS.map(() => "1h").join(","));

  const headers = { accept: "application/json" };
  if (process.env.ASPECTA_COOKIE) headers.cookie = process.env.ASPECTA_COOKIE;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Aspecta API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return parseSnapshot(data);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// 带 TTL 缓存 + single-flight，避免命令并发/与轮询重叠时打多次外部请求
let snapshotCache = { ts: 0, data: null, promise: null };
async function fetchSnapshotCached(maxAgeMs = 15000) {
  const now = Date.now();
  if (snapshotCache.data && now - snapshotCache.ts < maxAgeMs) {
    return snapshotCache.data;
  }
  if (snapshotCache.promise) return snapshotCache.promise;
  snapshotCache.promise = fetchSnapshot()
    .then((data) => {
      snapshotCache = { ts: Date.now(), data, promise: null };
      return data;
    })
    .catch((err) => {
      snapshotCache.promise = null;
      throw err;
    });
  return snapshotCache.promise;
}

// ── 即将上市（pre_launch）项目 ──────────────────────────────────
// 返回字段名不确定，按多个候选名取值，取不到则降级。
function pickField(obj, names) {
  for (const n of names) {
    if (obj && obj[n] != null) return obj[n];
    if (obj && obj.asset && obj.asset[n] != null) return obj.asset[n];
  }
  return null;
}

function parseUpcoming(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.data)
      ? raw.data
      : [];
  return list.map((item) => {
    const name = pickField(item, [
      "name",
      "symbol",
      "display_name",
      "project_name",
      "project_address",
      "wallet_address",
    ]);
    const startRaw = pickField(item, [
      "trade_start_time",
      "trading_start_time",
      "trade_open_time",
      "trading_start_at",
      "start_time",
      "start_at",
      "launch_time",
      "open_time",
    ]);
    const startMs = startRaw != null ? Date.parse(String(startRaw)) : NaN;
    const canTrade = pickField(item, ["can_trade", "canTrade", "tradable"]) === true;
    const state = pickField(item, ["state", "status"]);
    return {
      name: name != null ? String(name) : "?",
      startAt: Number.isFinite(startMs) ? startMs : null,
      startRaw: startRaw != null ? String(startRaw) : null,
      canTrade,
      state: state != null ? String(state) : null,
    };
  });
}

async function fetchUpcoming(retries = 1) {
  const url = new URL(ASSETS_API);
  url.searchParams.set("current_page", "1");
  url.searchParams.set("page_size", "50");
  url.searchParams.set("trading_config_id", TRADING_CONFIG_ID);
  url.searchParams.set("group", "pre_launch");
  url.searchParams.set("is_test", "false");

  const headers = { accept: "application/json" };
  if (process.env.ASPECTA_COOKIE) headers.cookie = process.env.ASPECTA_COOKIE;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`assets-list ${res.status} ${res.statusText}`);
      return parseUpcoming(await res.json());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function fmtUTC(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function fmtCountdown(ms) {
  if (ms <= 0) return "已开盘";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}天${h}小时后`;
  if (h > 0) return `${h}小时${m}分后`;
  return `${m}分钟后`;
}

function upcomingLine(u) {
  const parts = [`🆕 <b>${esc(u.name)}</b>`];
  if (u.startAt != null) {
    parts.push(`开盘 ${fmtUTC(u.startAt)} UTC（${fmtCountdown(u.startAt - Date.now())}）`);
  } else if (u.startRaw) {
    parts.push(`开盘 ${esc(u.startRaw)}`);
  }
  parts.push(u.canTrade ? "可交易 ✅" : "可交易 ❌");
  return parts.join("\n");
}

function parseSnapshot(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.data)
      ? raw.data
      : [];

  return list.map((item) => {
    const project = item.project_address;
    const kline = Array.isArray(item.k_line) ? item.k_line.slice() : [];
    if (kline.length === 0) return { project, ok: false };

    kline.sort((a, b) => a.ended_at - b.ended_at);
    const first = kline[0]; // 返回数据里的第一根K线
    const latest = kline[kline.length - 1]; // 最新K线
    const prev = kline.length >= 2 ? kline[kline.length - 2] : null; // 上一根K线

    const price = toPrice(latest.close_price);
    const change24h = pct(price, toPrice(first.open_price));
    const change1h = prev ? pct(price, toPrice(prev.close_price)) : null;

    // 24H 区间内所有 K 线的最高/最低
    const highs = kline
      .map((x) => toPrice(x.high_price))
      .filter((v) => v != null && isFinite(v));
    const lows = kline
      .map((x) => toPrice(x.low_price))
      .filter((v) => v != null && isFinite(v));
    const high24h = highs.length ? Math.max(...highs) : null;
    const low24h = lows.length ? Math.min(...lows) : null;

    return {
      project,
      ok: true,
      price,
      change1h,
      change24h,
      high24h,
      low24h,
      candles: kline.length,
    };
  });
}

// ── 4. 本轮变化对比 ─────────────────────────────────────────────
// pollLookbackSec=0 时对比上一次轮询；>0 时对比约 N 秒前的价格，
// 这样“慢涨累积”的异动也能被抓到，而不只是单个间隔内的突变。
function getPollChange(project, currentPrice) {
  const now = Date.now();
  let hist = priceHistory.get(project);
  if (!hist) {
    hist = [];
    priceHistory.set(project, hist);
  }

  const lookbackMs = settings.pollLookbackSec * 1000;
  let basePrice = null;
  if (lookbackMs > 0) {
    const cutoff = now - lookbackMs;
    for (const e of hist) {
      if (e.t <= cutoff) basePrice = e.price; // 取不晚于 cutoff 的最近一条
      else break;
    }
  } else if (hist.length) {
    basePrice = hist[hist.length - 1].price; // 对比上一次轮询
  }

  hist.push({ t: now, price: currentPrice });

  // 修剪历史，保留窗口 + 10 分钟缓冲，避免无限增长
  const keepMs = lookbackMs + 10 * 60 * 1000;
  while (hist.length && hist[0].t < now - keepMs) hist.shift();

  if (basePrice == null || basePrice === 0) return null;
  return ((currentPrice - basePrice) / basePrice) * 100;
}

function fmtWindow(sec) {
  if (sec % 3600 === 0) return `${sec / 3600}小时`;
  if (sec % 60 === 0) return `${sec / 60}分钟`;
  return `${sec}秒`;
}

function pollLabel() {
  return settings.pollLookbackSec > 0
    ? `近${fmtWindow(settings.pollLookbackSec)}变化`
    : "本轮变化";
}

// ── 5. 冷却判断 ─────────────────────────────────────────────────
function canAlertKey(key) {
  const now = Date.now();
  const last = alertCooldown.get(key) || 0;
  if (now - last < settings.cooldownMin * 60 * 1000) return false;
  alertCooldown.set(key, now);
  return true;
}

// ── 6. Telegram 发消息 ──────────────────────────────────────────
function chunkText(text, max = 4000) {
  if (text.length <= max) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let cur = "";
  for (const ln of lines) {
    if ((cur ? cur.length + 1 : 0) + ln.length > max) {
      if (cur) chunks.push(cur);
      cur = ln;
    } else {
      cur = cur ? cur + "\n" + ln : ln;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) {
    console.warn("[tg] TELEGRAM_BOT_TOKEN 未设置，跳过发送");
    return;
  }
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    // reply_markup 等附加项只挂在最后一块消息上
    if (i === chunks.length - 1) Object.assign(body, extra);
    try {
      const res = await fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`[tg] sendMessage ${res.status}`, await res.text());
      }
    } catch (e) {
      console.error("[tg] sendMessage 失败:", e.message);
    }
  }
}

async function answerCallback(callbackId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.error("[tg] answerCallbackQuery 失败:", e.message);
  }
}

// 启动时注册命令菜单（Telegram 输入框旁的 “菜单” 按钮）
async function registerCommands() {
  if (!BOT_TOKEN) return;
  const commands = [
    { command: "menu", description: "打开功能菜单" },
    { command: "now", description: "立即查询全部项目" },
    { command: "top", description: "24H 涨跌排行" },
    { command: "upcoming", description: "即将上市（pre-launch）项目" },
    { command: "detail", description: "查看单个项目，如 /detail GAEA" },
    { command: "subscribe", description: "把提醒订阅到当前话题" },
    { command: "unsubscribe", description: "取消当前话题的订阅" },
    { command: "subs", description: "查看所有订阅目标" },
    { command: "pause", description: "暂停自动提醒" },
    { command: "resume", description: "恢复自动提醒" },
    { command: "status", description: "查看当前配置" },
    { command: "set_interval", description: "设置查询间隔（秒）" },
    { command: "set_poll", description: "设置本轮变化阈值（%）" },
    { command: "set_day", description: "设置 24H 变化阈值（%）" },
    { command: "set_rearm", description: "设置 24H 回滞阈值（%）" },
    { command: "set_cooldown", description: "设置提醒冷却（分钟）" },
    { command: "set_lookback", description: "设置本轮变化回看窗口（秒）" },
    { command: "id", description: "查看当前 chat_id / topic_id" },
    { command: "help", description: "查看命令列表" },
  ];
  try {
    const res = await fetch(`${TG_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`[tg] setMyCommands ${res.status}`, await res.text());
    } else {
      console.log("[tg] 命令菜单已注册");
    }
  } catch (e) {
    console.error("[tg] setMyCommands 失败:", e.message);
  }
}

function pollShort() {
  return settings.pollLookbackSec > 0
    ? `近${fmtWindow(settings.pollLookbackSec)}`
    : "本轮";
}

// 24H 边沿触发 + 回滞：返回是否应触发 24H 提醒（不消费冷却）。
// dayState: 0=已武装/正常, 1=已锁定向上, -1=已锁定向下。
// 触发用 dayAlertPercent，回落到 dayRearmPercent 内才重新武装，避免在阈值附近抖动反复触发。
function evalDayAlert(project, change24h) {
  if (change24h == null) return false;
  const trig = settings.dayAlertPercent;
  const rearm = Math.min(settings.dayRearmPercent, trig);
  const prev = dayState.get(project);
  let state = prev === undefined ? null : prev;
  let fire = false;

  if (state === null) {
    // 冷启动/首次见到：只建立基线，不报
    state = change24h >= trig ? 1 : change24h <= -trig ? -1 : 0;
  } else if (state === 0) {
    if (change24h >= trig) {
      state = 1;
      fire = true;
    } else if (change24h <= -trig) {
      state = -1;
      fire = true;
    }
  } else if (state === 1) {
    if (change24h <= -trig) {
      state = -1;
      fire = true;
    } else if (change24h < rearm) {
      state = 0; // 回落到再武装线内
    }
  } else {
    // state === -1
    if (change24h >= trig) {
      state = 1;
      fire = true;
    } else if (change24h > -rearm) {
      state = 0;
    }
  }
  dayState.set(project, state);
  return fire;
}

const dirIcon = (x) => (x == null ? "" : x >= 0 ? "🟢" : "🔴");

// 单个项目的告警块（隐藏无数据的行）
function alertBlock(item, pollChange, reasons) {
  const primary = item.change24h != null ? item.change24h : pollChange;
  const arrow = primary != null && primary < 0 ? "📉" : "📈";
  const metrics = [];
  if (pollChange != null) {
    metrics.push(`${pollShort()} ${dirIcon(pollChange)}${fmtPct(pollChange)}`);
  }
  if (item.change1h != null) {
    metrics.push(`1H ${dirIcon(item.change1h)}${fmtPct(item.change1h)}`);
  }
  if (item.change24h != null) {
    metrics.push(`24H ${dirIcon(item.change24h)}${fmtPct(item.change24h)}`);
  }
  return [
    `${arrow} <b>${esc(item.project)}</b>  $${fmtPrice(item.price)}  <i>[${reasons.join("/")}]</i>`,
    metrics.join("  "),
  ].join("\n");
}

// 同一轮触发的多个项目合并成一条消息
function batchedMessage(triggered) {
  const sev = (t) =>
    Math.max(
      t.pollChange != null ? Math.abs(t.pollChange) : 0,
      t.item.change24h != null ? Math.abs(t.item.change24h) : 0,
    );
  triggered.sort((a, b) => sev(b) - sev(a));
  const blocks = triggered.map((t) =>
    alertBlock(t.item, t.pollChange, t.reasons),
  );
  if (blocks.length === 1) return blocks[0]; // 单个项目无需头部
  return [`⚠️ <b>异动 ×${blocks.length}</b>`, ...blocks].join("\n\n");
}

// 启动时的“当前异动”快照
function startupSnapshot(snapshot) {
  const hot = snapshot
    .filter(
      (it) =>
        it.ok &&
        it.change24h != null &&
        Math.abs(it.change24h) >= settings.dayAlertPercent,
    )
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  const lines = ["🤖 <b>Aspecta 价格追踪已启动</b>"];
  if (hot.length === 0) {
    lines.push(`当前无明显异动（24H 阈值 ${settings.dayAlertPercent}%）`);
  } else {
    lines.push(`当前异动（24H ≥ ${settings.dayAlertPercent}%）：`);
    for (const it of hot) {
      const arrow = it.change24h < 0 ? "📉" : "📈";
      lines.push(
        `${arrow} <b>${esc(it.project)}</b>  ${fmtPct(it.change24h)}  ($${fmtPrice(it.price)})`,
      );
    }
  }
  lines.push("", "发送 /menu 打开菜单");
  return lines.join("\n");
}

// 把消息发到所有订阅的目标（群/话题）
async function broadcast(text, extra = {}) {
  for (const sub of subscriptions.values()) {
    await sendTelegram(sub.chatId, text, threadExtra(sub.threadId, { ...extra }));
  }
}

// ── 定时轮询主循环 ──────────────────────────────────────────────
let firstCycle = true; // 首轮（含每次重启）只建基线 + 发快照，不轰炸

async function runPollCycle() {
  if (settings.paused) return;
  if (subscriptions.size === 0) return; // 没有订阅目标，无法推送提醒

  const snapshot = await fetchSnapshot();
  snapshotCache = { ts: Date.now(), data: snapshot, promise: null }; // 供命令复用
  const triggered = [];

  for (const item of snapshot) {
    if (!item.ok || item.price == null || !isFinite(item.price)) continue;

    const pollChange = getPollChange(item.project, item.price);
    if (pollChange != null) lastPollChange.set(item.project, pollChange);

    const pollHit =
      pollChange != null && Math.abs(pollChange) >= settings.pollAlertPercent;
    const dayHit = evalDayAlert(item.project, item.change24h); // 边沿+回滞，更新 dayState

    if (!pollHit && !dayHit) continue;

    // 冷却：project 作用域下同项目共用一个冷却并合并原因；type 作用域下本轮/24H 各自独立
    let types;
    if (COOLDOWN_SCOPE === "type") {
      types = [];
      if (pollHit && canAlertKey(`${item.project}:poll`)) types.push("poll");
      if (dayHit && canAlertKey(`${item.project}:day`)) types.push("day");
    } else {
      const hits = [];
      if (pollHit) hits.push("poll");
      if (dayHit) hits.push("day");
      types = canAlertKey(`${item.project}:any`) ? hits : [];
    }
    if (types.length === 0) continue;

    const reasons = types.map((t) => (t === "poll" ? pollShort() : "24H"));
    triggered.push({ item, pollChange, reasons });
  }

  // 首轮（或重启后第一轮）：发当前异动快照，不发逐项告警
  if (firstCycle) {
    firstCycle = false;
    await broadcast(startupSnapshot(snapshot));
    return;
  }

  if (triggered.length) {
    await broadcast(batchedMessage(triggered));
  }
}

async function pollLoop() {
  // 持续运行，每轮结束后按当前 interval 休眠（支持运行时修改）
  while (true) {
    try {
      await runPollCycle();
    } catch (e) {
      console.error("[poll] 轮询出错:", e.message);
    }
    await sleep(settings.pollIntervalSec * 1000);
  }
}

// 即将上市监控：首轮静默建基线；之后只在“新项目 / 即将开盘 / 已可交易”时提醒
let firstUpcomingCycle = true;

async function runUpcomingCycle() {
  if (subscriptions.size === 0) return;
  const list = await fetchUpcoming();
  const now = Date.now();
  const soonMs = LAUNCH_SOON_MIN * 60 * 1000;
  const events = [];

  for (const u of list) {
    const isSoon =
      u.startAt != null && u.startAt - now > 0 && u.startAt - now <= soonMs;
    const prev = knownUpcoming.get(u.name);

    if (!prev) {
      // 首次见到：建基线，不报（运行中新出现的才报）
      if (!firstUpcomingCycle) {
        const when = u.startAt != null
          ? `\n开盘 ${fmtUTC(u.startAt)} UTC（${fmtCountdown(u.startAt - now)}）`
          : "";
        events.push(`🆕 <b>新预上市项目</b>：<b>${esc(u.name)}</b>${when}`);
      }
      knownUpcoming.set(u.name, {
        startAt: u.startAt,
        canTrade: u.canTrade,
        notifiedSoon: isSoon, // 启动时已临近的不再单独提醒，避免重启刷屏
      });
      continue;
    }

    if (u.canTrade && !prev.canTrade) {
      events.push(`🚀 <b>${esc(u.name)}</b> 已开盘，现在可以交易了！`);
    }
    if (isSoon && !prev.notifiedSoon) {
      events.push(
        `⏰ <b>${esc(u.name)}</b> 即将开盘（${fmtCountdown(u.startAt - now)}）\n开盘 ${fmtUTC(u.startAt)} UTC`,
      );
    }
    knownUpcoming.set(u.name, {
      startAt: u.startAt,
      canTrade: u.canTrade,
      notifiedSoon: prev.notifiedSoon || isSoon,
    });
  }

  // 清理已离开 pre_launch 列表的项目（已上市/下架）
  const names = new Set(list.map((u) => u.name));
  for (const key of [...knownUpcoming.keys()]) {
    if (!names.has(key)) knownUpcoming.delete(key);
  }

  firstUpcomingCycle = false;
  for (const text of events) await broadcast(text);
}

async function upcomingLoop() {
  if (!UPCOMING_ENABLED) {
    console.log("[upcoming] 预上市监控已禁用");
    return;
  }
  while (true) {
    try {
      await runUpcomingCycle();
    } catch (e) {
      console.error("[upcoming] 出错:", e.message);
    }
    await sleep(UPCOMING_INTERVAL_SEC * 1000);
  }
}

// ── Telegram 命令（long polling）────────────────────────────────
// 点击式菜单（inline keyboard）。callback_data 直接复用命令名
const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📊 全部项目", callback_data: "now" },
      { text: "🏆 涨跌排行", callback_data: "top" },
    ],
    [
      { text: "🆕 即将上市", callback_data: "upcoming" },
      { text: "⚙️ 当前配置", callback_data: "status" },
    ],
    [
      { text: "📌 订阅本话题", callback_data: "subscribe" },
      { text: "🚫 取消订阅", callback_data: "unsubscribe" },
    ],
    [
      { text: "⏸ 暂停提醒", callback_data: "pause" },
      { text: "▶️ 恢复提醒", callback_data: "resume" },
    ],
    [{ text: "❓ 帮助", callback_data: "help" }],
  ],
};

const HELP_TEXT = [
  "🤖 <b>Aspecta 价格追踪机器人</b>",
  "",
  "/menu - 打开功能菜单",
  "/now - 立即查询全部项目",
  "/top - 24H 涨跌排行",
  "/upcoming - 即将上市（pre-launch）项目",
  "/detail &lt;项目&gt; - 查看单个项目，如 /detail GAEA",
  "/subscribe - 把提醒订阅到当前话题",
  "/unsubscribe - 取消当前话题的订阅",
  "/subs - 查看所有订阅目标",
  "/pause - 暂停自动提醒",
  "/resume - 恢复自动提醒",
  "/set_interval &lt;秒&gt; - 设置查询间隔（最小 10）",
  "/set_poll &lt;百分比&gt; - 本轮变化提醒阈值",
  "/set_day &lt;百分比&gt; - 24H 变化提醒阈值",
  "/set_rearm &lt;百分比&gt; - 24H 回滞阈值（回落到此值内才再次触发）",
  "/set_cooldown &lt;分钟&gt; - 同项目提醒冷却",
  "/set_lookback &lt;秒&gt; - 本轮变化回看窗口（0=对比上一次轮询）",
  "/status - 查看当前配置",
  "/id - 查看当前 chat_id / topic_id",
].join("\n");

function statusText() {
  return [
    "⚙️ <b>当前配置</b>",
    `自动提醒：${settings.paused ? "⏸ 已暂停" : "▶️ 运行中"}`,
    `查询间隔：${settings.pollIntervalSec}s`,
    `本轮阈值：${settings.pollAlertPercent}%`,
    `本轮窗口：${settings.pollLookbackSec > 0 ? fmtWindow(settings.pollLookbackSec) : "上一次轮询"}`,
    `24H阈值：${settings.dayAlertPercent}%（回滞 ${settings.dayRearmPercent}%）`,
    `冷却时间：${settings.cooldownMin}min（作用域 ${COOLDOWN_SCOPE}）`,
    `订阅目标：${subscriptions.size}`,
    `权限控制：${ADMIN_USER_IDS.size > 0 ? `仅 ${ADMIN_USER_IDS.size} 名管理员` : "开放"}`,
    `预上市监控：${UPCOMING_ENABLED ? `每 ${UPCOMING_INTERVAL_SEC}s（临近 ${LAUNCH_SOON_MIN}min 提醒）` : "关闭"}`,
    `项目数量：${PROJECTS.length}`,
  ].join("\n");
}

async function cmdNow(chatId, threadId) {
  const snap = await fetchSnapshotCached();
  const lines = ["📊 <b>Aspecta 全部项目</b>"];
  for (const it of snap) {
    if (!it.ok) {
      lines.push(`<b>${esc(it.project)}</b>  无数据`);
      continue;
    }
    lines.push(
      `<b>${esc(it.project)}</b>  $${fmtPrice(it.price)}  ` +
        `1H ${fmtPct(it.change1h)}  24H ${fmtPct(it.change24h)}`,
    );
  }
  await sendTelegram(chatId, lines.join("\n"), threadExtra(threadId));
}

async function cmdUpcoming(chatId, threadId) {
  let list;
  try {
    list = await fetchUpcoming();
  } catch (e) {
    await sendTelegram(chatId, `❌ 获取即将上市列表失败：${esc(e.message)}`, threadExtra(threadId));
    return;
  }
  if (list.length === 0) {
    await sendTelegram(chatId, "暂无即将上市的项目", threadExtra(threadId));
    return;
  }
  // 最快开盘的排前面，无时间的排最后
  list.sort((a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity));
  const lines = [`🆕 <b>即将上市 (${list.length})</b>`, ""];
  for (const u of list) lines.push(upcomingLine(u), "");
  await sendTelegram(chatId, lines.join("\n").trim(), threadExtra(threadId));
}

async function cmdTop(chatId, threadId) {
  const snap = (await fetchSnapshotCached()).filter(
    (it) => it.ok && it.change24h != null,
  );
  snap.sort((a, b) => b.change24h - a.change24h);
  const lines = ["🏆 <b>24H 涨跌排行</b>"];
  snap.forEach((it, i) => {
    lines.push(
      `${i + 1}. <b>${esc(it.project)}</b>  ${fmtPct(it.change24h)}  ($${fmtPrice(it.price)})`,
    );
  });
  await sendTelegram(chatId, lines.join("\n"), threadExtra(threadId));
}

async function cmdDetail(chatId, threadId, name) {
  if (!name) {
    await sendTelegram(
      chatId,
      "用法：/detail &lt;项目&gt;，例如 /detail GAEA",
      threadExtra(threadId),
    );
    return;
  }
  const snap = await fetchSnapshotCached();
  const it = snap.find(
    (x) => x.project.toLowerCase() === name.toLowerCase(),
  );
  if (!it) {
    await sendTelegram(chatId, `未找到项目：${esc(name)}`, threadExtra(threadId));
    return;
  }
  if (!it.ok) {
    await sendTelegram(
      chatId,
      `<b>${esc(it.project)}</b> 暂无数据`,
      threadExtra(threadId),
    );
    return;
  }
  const poll = lastPollChange.get(it.project);
  await sendTelegram(
    chatId,
    [
      `📈 <b>${esc(it.project)}</b>`,
      `最新价：$${fmtPrice(it.price)}`,
      `${pollLabel()}：${poll != null ? fmtPct(poll) : "N/A"}`,
      `1H变化：${fmtPct(it.change1h)}`,
      `24H变化：${fmtPct(it.change24h)}`,
      `24H最高：$${fmtPrice(it.high24h)}`,
      `24H最低：$${fmtPrice(it.low24h)}`,
    ].join("\n"),
    threadExtra(threadId),
  );
}

// 会修改状态的命令（订阅/暂停/改阈值等），受管理员限制并触发持久化
const MUTATING_COMMANDS = new Set([
  "/subscribe",
  "/unsubscribe",
  "/pause",
  "/resume",
  "/set_interval",
  "/set_poll",
  "/set_day",
  "/set_rearm",
  "/set_cooldown",
  "/set_lookback",
]);

function isAdminUser(userId) {
  return ADMIN_USER_IDS.size === 0 || ADMIN_USER_IDS.has(String(userId));
}

async function handleCommand(chatId, threadId, cmd, args) {
  const reply = (text, extra = {}) =>
    sendTelegram(chatId, text, threadExtra(threadId, extra));
  switch (cmd) {
    case "/start":
    case "/help":
      await reply(HELP_TEXT);
      break;
    case "/menu":
      await reply("📋 <b>功能菜单</b>\n点击下方按钮操作：", {
        reply_markup: MENU_KEYBOARD,
      });
      break;
    case "/status":
      await reply(statusText());
      break;
    case "/now":
      await cmdNow(chatId, threadId);
      break;
    case "/top":
      await cmdTop(chatId, threadId);
      break;
    case "/upcoming":
      await cmdUpcoming(chatId, threadId);
      break;
    case "/detail":
      await cmdDetail(chatId, threadId, args[0]);
      break;
    case "/subscribe":
      addSubscription(chatId, threadId);
      await reply(
        [
          "✅ 已订阅本话题，之后的提醒会发送到这里",
          `chat_id: <code>${chatId}</code>`,
          threadId != null ? `topic_id: <code>${threadId}</code>` : "话题: General",
        ].join("\n"),
      );
      break;
    case "/unsubscribe":
      if (removeSubscription(chatId, threadId)) {
        await reply("🚫 已取消订阅本话题");
      } else {
        await reply("ℹ️ 本话题尚未订阅");
      }
      break;
    case "/subs": {
      if (subscriptions.size === 0) {
        await reply("当前没有任何订阅，进入目标话题发送 /subscribe 即可");
        break;
      }
      const lines = ["📌 <b>当前订阅目标</b>"];
      for (const s of subscriptions.values()) {
        lines.push(
          `chat <code>${s.chatId}</code>` +
            (s.threadId != null ? ` / topic <code>${s.threadId}</code>` : " / General"),
        );
      }
      await reply(lines.join("\n"));
      break;
    }
    case "/pause":
      settings.paused = true;
      await reply("⏸ 已暂停自动提醒");
      break;
    case "/resume":
      settings.paused = false;
      await reply("▶️ 已恢复自动提醒");
      break;
    case "/set_interval": {
      const v = parseInt(args[0], 10);
      if (!Number.isFinite(v) || v < 10) {
        await reply("❌ 请输入 ≥10 的秒数，例如 /set_interval 60");
        break;
      }
      settings.pollIntervalSec = v;
      await reply(`✅ 查询间隔已设为 ${v}s`);
      break;
    }
    case "/set_poll": {
      const v = parseFloat(args[0]);
      if (!Number.isFinite(v) || v < 0) {
        await reply("❌ 请输入百分比，例如 /set_poll 1");
        break;
      }
      settings.pollAlertPercent = v;
      await reply(`✅ 本轮变化阈值已设为 ${v}%`);
      break;
    }
    case "/set_day": {
      const v = parseFloat(args[0]);
      if (!Number.isFinite(v) || v < 0) {
        await reply("❌ 请输入百分比，例如 /set_day 5");
        break;
      }
      settings.dayAlertPercent = v;
      await reply(`✅ 24H 变化阈值已设为 ${v}%`);
      break;
    }
    case "/set_rearm": {
      const v = parseFloat(args[0]);
      if (!Number.isFinite(v) || v < 0) {
        await reply("❌ 请输入百分比，例如 /set_rearm 4（24H 回落到此值内才再次允许触发）");
        break;
      }
      settings.dayRearmPercent = v;
      await reply(`✅ 24H 回滞阈值已设为 ${v}%`);
      break;
    }
    case "/set_cooldown": {
      const v = parseInt(args[0], 10);
      if (!Number.isFinite(v) || v < 0) {
        await reply("❌ 请输入 ≥0 的分钟数，例如 /set_cooldown 5");
        break;
      }
      settings.cooldownMin = v;
      await reply(`✅ 提醒冷却已设为 ${v}min`);
      break;
    }
    case "/set_lookback": {
      const v = parseInt(args[0], 10);
      if (!Number.isFinite(v) || v < 0) {
        await reply("❌ 请输入 ≥0 的秒数，例如 /set_lookback 300（0=对比上一次轮询）");
        break;
      }
      settings.pollLookbackSec = v;
      await reply(
        v > 0
          ? `✅ 本轮变化改为对比近 ${fmtWindow(v)}`
          : "✅ 本轮变化改为对比上一次轮询",
      );
      break;
    }
    default:
      await reply(HELP_TEXT);
  }
  if (MUTATING_COMMANDS.has(cmd)) saveState();
}

async function handleCallback(cq) {
  const msg = cq.message;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  const threadId = msg ? msg.message_thread_id : null;
  await answerCallback(cq.id); // 先确认，停止按钮转圈
  if (chatId == null) return;
  const data = String(cq.data || "");
  if (!data) return;
  const cmdName = "/" + data;
  if (MUTATING_COMMANDS.has(cmdName) && !isAdminUser(cq.from && cq.from.id)) {
    await sendTelegram(chatId, "❌ 无权限执行该命令", threadExtra(threadId));
    return;
  }
  try {
    await handleCommand(chatId, threadId, cmdName, []);
  } catch (e) {
    console.error("[tg] 回调处理出错:", e.message);
    await sendTelegram(chatId, `❌ 出错了：${esc(e.message)}`, threadExtra(threadId));
  }
}

async function handleUpdate(upd) {
  if (upd.callback_query) {
    await handleCallback(upd.callback_query);
    return;
  }
  const msg = upd.message || upd.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id != null ? msg.message_thread_id : null;
  const text = msg.text.trim();
  if (!text.startsWith("/")) return;

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase(); // 去掉 @botname
  const args = parts.slice(1);

  if (cmd === "/id") {
    const lines = [
      `🆔 Chat ID: <code>${chatId}</code>`,
      `类型: ${msg.chat.type}`,
    ];
    if (threadId != null) {
      lines.push(`🧵 Topic ID: <code>${threadId}</code>`);
    }
    await sendTelegram(chatId, lines.join("\n"), threadExtra(threadId));
    return;
  }
  if (MUTATING_COMMANDS.has(cmd) && !isAdminUser(msg.from && msg.from.id)) {
    await sendTelegram(chatId, "❌ 无权限执行该命令", threadExtra(threadId));
    return;
  }
  try {
    await handleCommand(chatId, threadId, cmd, args);
  } catch (e) {
    console.error("[tg] 命令处理出错:", e.message);
    await sendTelegram(chatId, `❌ 出错了：${esc(e.message)}`, threadExtra(threadId));
  }
}

// long polling 与 webhook 互斥；启动时先清理 webhook，否则 getUpdates 不工作
async function deleteWebhook() {
  if (!BOT_TOKEN) return;
  try {
    const res = await fetch(`${TG_API}/deleteWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: false }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      console.error("[tg] deleteWebhook 失败", res.status, data);
    } else {
      console.log("[tg] 已清理 webhook，使用 long polling");
    }
  } catch (e) {
    console.error("[tg] deleteWebhook 异常:", e.message);
  }
}

async function telegramPollLoop() {
  if (!BOT_TOKEN) {
    console.warn("[tg] 未设置 TELEGRAM_BOT_TOKEN，命令监听已禁用");
    return;
  }
  await deleteWebhook();
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `${TG_API}/getUpdates?timeout=30&offset=${offset}`,
        { signal: AbortSignal.timeout(40000) },
      );
      if (res.status === 429) {
        const data = await res.json().catch(() => null);
        const retry = (data && data.parameters && data.parameters.retry_after) || 5;
        console.warn(`[tg] 429 限流，${retry}s 后重试`);
        await sleep(retry * 1000);
        continue;
      }
      if (res.status === 409) {
        console.error(
          "[tg] 409 Conflict：可能有另一个实例也在 getUpdates（旧实例未退出 / 双实例）",
        );
        await sleep(5000);
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        console.error("[tg] getUpdates 异常", res.status, data);
        await sleep(3000);
        continue;
      }
      if (Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          await handleUpdate(upd);
        }
      }
    } catch (e) {
      console.error("[tg] getUpdates 失败:", e.message);
      await sleep(3000);
    }
  }
}

// ── 健康检查（Node 内置 http，无第三方依赖）─────────────────────
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          paused: settings.paused,
          pollIntervalSec: settings.pollIntervalSec,
          projects: PROJECTS.length,
          tracked: priceHistory.size,
          subscriptions: subscriptions.size,
          uptimeSec: Math.round(process.uptime()),
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Aspecta Telegram Tracker is running");
  });
  server.listen(PORT, () => console.log(`[http] 监听端口 ${PORT}`));
}

function main() {
  console.log("[boot] Aspecta Telegram Tracker 启动中...");

  loadState(); // 先恢复持久化的订阅 + 设置

  console.log(
    `[boot] 间隔=${settings.pollIntervalSec}s 本轮阈值=${settings.pollAlertPercent}% ` +
      `回看=${settings.pollLookbackSec}s 24H阈值=${settings.dayAlertPercent}% ` +
      `回滞=${settings.dayRearmPercent}% 冷却=${settings.cooldownMin}min ` +
      `作用域=${COOLDOWN_SCOPE} 项目数=${PROJECTS.length}`,
  );
  seedSubscriptions(); // 再用环境变量兜底默认订阅
  if (TOPIC_ID != null) console.log(`[boot] 默认订阅话题 topic_id=${TOPIC_ID}`);
  if (!BOT_TOKEN) console.warn("[boot] 警告：未设置 TELEGRAM_BOT_TOKEN");
  if (subscriptions.size === 0) {
    console.warn(
      "[boot] 警告：暂无订阅目标，设置 TELEGRAM_CHAT_ID 或在话题里发 /subscribe",
    );
  }

  startServer();
  registerCommands();
  telegramPollLoop();
  pollLoop(); // 首轮会发送“当前异动快照”，无需在此单独发启动消息
  upcomingLoop(); // 即将上市监控
}

if (require.main === module) {
  main();
}

module.exports = {
  PROJECTS,
  toPrice,
  pct,
  fmtPrice,
  fmtPct,
  esc,
  parseSnapshot,
  parseUpcoming,
  getPollChange,
  canAlertKey,
  evalDayAlert,
  alertBlock,
  batchedMessage,
  startupSnapshot,
  isAdminUser,
  MUTATING_COMMANDS,
  ADMIN_USER_IDS,
  settings,
  // 暴露内部状态供测试重置
  _state: { priceHistory, lastPollChange, alertCooldown, dayState, subscriptions },
};
