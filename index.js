"use strict";

const express = require("express");

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

// ── 配置（环境变量 + 运行时可改）────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// 可选：群组话题(forum topic)的 message_thread_id，提醒会发到该话题
const TOPIC_ID = (() => {
  const v = parseInt(process.env.TELEGRAM_TOPIC_ID, 10);
  return Number.isFinite(v) ? v : null;
})();
const PORT = parseInt(process.env.PORT, 10) || 3000;

function intEnv(name, def, min) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min ? v : def;
}
function floatEnv(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

const settings = {
  pollIntervalSec: intEnv("POLL_INTERVAL_SEC", 60, 10),
  pollAlertPercent: floatEnv("POLL_ALERT_PERCENT", 1),
  dayAlertPercent: floatEnv("DAY_ALERT_PERCENT", 5),
  cooldownMin: intEnv("ALERT_COOLDOWN_MIN", 30),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 工具函数 ────────────────────────────────────────────────────
function toPrice(value) {
  // open_price / close_price / high_price / low_price 为 18 位精度
  return Number(value) / 1e18;
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
async function fetchSnapshot() {
  const url = new URL(ASPECTA_API);
  url.searchParams.set("project_address", PROJECTS.join(","));
  url.searchParams.set("offset", PROJECTS.map(() => "24").join(","));
  url.searchParams.set("window_type", PROJECTS.map(() => "1h").join(","));

  const headers = { accept: "application/json" };
  if (process.env.ASPECTA_COOKIE) headers.cookie = process.env.ASPECTA_COOKIE;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Aspecta API ${res.status} ${res.statusText}`);
  const data = await res.json();
  return parseSnapshot(data);
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
    const high = latest.high_price != null ? toPrice(latest.high_price) : null;
    const low = latest.low_price != null ? toPrice(latest.low_price) : null;

    return {
      project,
      ok: true,
      price,
      change1h,
      change24h,
      high,
      low,
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
function canAlert(project, type) {
  const key = `${project}:${type}`;
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

// 24H 所处区间：1=向上超阈值，-1=向下超阈值，0=阈值内
function dayBucket(change24h) {
  if (change24h == null) return 0;
  if (change24h >= settings.dayAlertPercent) return 1;
  if (change24h <= -settings.dayAlertPercent) return -1;
  return 0;
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
  const triggered = [];

  for (const item of snapshot) {
    if (!item.ok || item.price == null || !isFinite(item.price)) continue;

    const pollChange = getPollChange(item.project, item.price);
    if (pollChange != null) lastPollChange.set(item.project, pollChange);

    // 24H 边沿触发：记录上次所处区间，只有“穿越”到新的超阈值区间才报
    const prevState = dayState.get(item.project);
    const curState = dayBucket(item.change24h);
    dayState.set(item.project, curState);

    const reasons = [];
    if (
      pollChange != null &&
      Math.abs(pollChange) >= settings.pollAlertPercent &&
      canAlert(item.project, "poll")
    ) {
      reasons.push(pollShort());
    }
    if (
      prevState !== undefined && // 首次见到该项目只建基线，不报
      curState !== 0 &&
      curState !== prevState &&
      canAlert(item.project, "day")
    ) {
      reasons.push("24H");
    }

    if (reasons.length) triggered.push({ item, pollChange, reasons });
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

// ── Telegram 命令（long polling）────────────────────────────────
// 点击式菜单（inline keyboard）。callback_data 直接复用命令名
const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📊 全部项目", callback_data: "now" },
      { text: "🏆 涨跌排行", callback_data: "top" },
    ],
    [{ text: "⚙️ 当前配置", callback_data: "status" }],
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
  "/detail &lt;项目&gt; - 查看单个项目，如 /detail GAEA",
  "/subscribe - 把提醒订阅到当前话题",
  "/unsubscribe - 取消当前话题的订阅",
  "/subs - 查看所有订阅目标",
  "/pause - 暂停自动提醒",
  "/resume - 恢复自动提醒",
  "/set_interval &lt;秒&gt; - 设置查询间隔（最小 10）",
  "/set_poll &lt;百分比&gt; - 本轮变化提醒阈值",
  "/set_day &lt;百分比&gt; - 24H 变化提醒阈值",
  "/set_cooldown &lt;分钟&gt; - 同项目同类型提醒冷却",
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
    `24H阈值：${settings.dayAlertPercent}%`,
    `冷却时间：${settings.cooldownMin}min`,
    `订阅目标：${subscriptions.size}`,
    `项目数量：${PROJECTS.length}`,
  ].join("\n");
}

async function cmdNow(chatId, threadId) {
  const snap = await fetchSnapshot();
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

async function cmdTop(chatId, threadId) {
  const snap = (await fetchSnapshot()).filter(
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
  const snap = await fetchSnapshot();
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
      `最高：$${fmtPrice(it.high)}`,
      `最低：$${fmtPrice(it.low)}`,
    ].join("\n"),
    threadExtra(threadId),
  );
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
}

async function handleCallback(cq) {
  const msg = cq.message;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  const threadId = msg ? msg.message_thread_id : null;
  await answerCallback(cq.id); // 先确认，停止按钮转圈
  if (chatId == null) return;
  const data = String(cq.data || "");
  if (!data) return;
  try {
    await handleCommand(chatId, threadId, "/" + data, []);
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
  try {
    await handleCommand(chatId, threadId, cmd, args);
  } catch (e) {
    console.error("[tg] 命令处理出错:", e.message);
    await sendTelegram(chatId, `❌ 出错了：${esc(e.message)}`, threadExtra(threadId));
  }
}

async function telegramPollLoop() {
  if (!BOT_TOKEN) {
    console.warn("[tg] 未设置 TELEGRAM_BOT_TOKEN，命令监听已禁用");
    return;
  }
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `${TG_API}/getUpdates?timeout=30&offset=${offset}`,
        { signal: AbortSignal.timeout(40000) },
      );
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
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

// ── Express 健康检查 + 启动 ─────────────────────────────────────
function startServer() {
  const app = express();
  app.get("/", (_req, res) =>
    res.send("Aspecta Telegram Tracker is running"),
  );
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      paused: settings.paused,
      pollIntervalSec: settings.pollIntervalSec,
      projects: PROJECTS.length,
      tracked: priceHistory.size,
      subscriptions: subscriptions.size,
      uptimeSec: Math.round(process.uptime()),
    }),
  );
  app.listen(PORT, () => console.log(`[http] 监听端口 ${PORT}`));
}

function main() {
  console.log("[boot] Aspecta Telegram Tracker 启动中...");
  console.log(
    `[boot] 间隔=${settings.pollIntervalSec}s 本轮阈值=${settings.pollAlertPercent}% ` +
      `回看=${settings.pollLookbackSec}s 24H阈值=${settings.dayAlertPercent}% ` +
      `冷却=${settings.cooldownMin}min 项目数=${PROJECTS.length}`,
  );

  seedSubscriptions();
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
  parseSnapshot,
  getPollChange,
  canAlert,
  dayBucket,
  alertBlock,
  batchedMessage,
  startupSnapshot,
  settings,
};
