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
  paused: false,
};

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 运行时状态
const lastPrices = new Map(); // project -> 上一轮价格
const lastPollChange = new Map(); // project -> 上一轮变化%
const alertCooldown = new Map(); // `${project}:${type}` -> 时间戳

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
function getPollChange(project, currentPrice) {
  const oldPrice = lastPrices.get(project);
  lastPrices.set(project, currentPrice);
  if (oldPrice == null || oldPrice === 0) return null;
  return ((currentPrice - oldPrice) / oldPrice) * 100;
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

async function sendTelegram(chatId, text) {
  if (!BOT_TOKEN) {
    console.warn("[tg] TELEGRAM_BOT_TOKEN 未设置，跳过发送");
    return;
  }
  for (const chunk of chunkText(text)) {
    try {
      const res = await fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
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

function alertMessage(item, pollChange, reasons) {
  return [
    `⚠️ <b>Aspecta 价格提醒</b> (${reasons.join(" / ")})`,
    `<b>${esc(item.project)}</b>`,
    `最新价：$${fmtPrice(item.price)}`,
    `本轮变化：${fmtPct(pollChange)}`,
    `1H变化：${fmtPct(item.change1h)}`,
    `24H变化：${fmtPct(item.change24h)}`,
  ].join("\n");
}

// ── 定时轮询主循环 ──────────────────────────────────────────────
async function runPollCycle() {
  if (settings.paused) return;
  if (!CHAT_ID) return; // 没有目标 chat，无法推送提醒

  const snapshot = await fetchSnapshot();
  for (const item of snapshot) {
    if (!item.ok || item.price == null || !isFinite(item.price)) continue;

    const pollChange = getPollChange(item.project, item.price);
    if (pollChange != null) lastPollChange.set(item.project, pollChange);

    const reasons = [];
    if (
      pollChange != null &&
      Math.abs(pollChange) >= settings.pollAlertPercent &&
      canAlert(item.project, "poll")
    ) {
      reasons.push("本轮");
    }
    if (
      item.change24h != null &&
      Math.abs(item.change24h) >= settings.dayAlertPercent &&
      canAlert(item.project, "day")
    ) {
      reasons.push("24H");
    }

    if (reasons.length) {
      await sendTelegram(CHAT_ID, alertMessage(item, pollChange, reasons));
    }
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
function isAuthorized(chatId) {
  // 未配置 CHAT_ID 时放开，便于初次设置；配置后仅限该 chat
  return !CHAT_ID || String(chatId) === String(CHAT_ID);
}

const HELP_TEXT = [
  "🤖 <b>Aspecta 价格追踪机器人</b>",
  "",
  "/now - 立即查询全部项目",
  "/top - 24H 涨跌排行",
  "/detail &lt;项目&gt; - 查看单个项目，如 /detail GAEA",
  "/pause - 暂停自动提醒",
  "/resume - 恢复自动提醒",
  "/set_interval &lt;秒&gt; - 设置查询间隔（最小 10）",
  "/set_poll &lt;百分比&gt; - 本轮变化提醒阈值",
  "/set_day &lt;百分比&gt; - 24H 变化提醒阈值",
  "/status - 查看当前配置",
  "/id - 查看当前 chat_id",
].join("\n");

function statusText() {
  return [
    "⚙️ <b>当前配置</b>",
    `自动提醒：${settings.paused ? "⏸ 已暂停" : "▶️ 运行中"}`,
    `查询间隔：${settings.pollIntervalSec}s`,
    `本轮阈值：${settings.pollAlertPercent}%`,
    `24H阈值：${settings.dayAlertPercent}%`,
    `冷却时间：${settings.cooldownMin}min`,
    `项目数量：${PROJECTS.length}`,
  ].join("\n");
}

async function cmdNow(chatId) {
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
  await sendTelegram(chatId, lines.join("\n"));
}

async function cmdTop(chatId) {
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
  await sendTelegram(chatId, lines.join("\n"));
}

async function cmdDetail(chatId, name) {
  if (!name) {
    await sendTelegram(chatId, "用法：/detail &lt;项目&gt;，例如 /detail GAEA");
    return;
  }
  const snap = await fetchSnapshot();
  const it = snap.find(
    (x) => x.project.toLowerCase() === name.toLowerCase(),
  );
  if (!it) {
    await sendTelegram(chatId, `未找到项目：${esc(name)}`);
    return;
  }
  if (!it.ok) {
    await sendTelegram(chatId, `<b>${esc(it.project)}</b> 暂无数据`);
    return;
  }
  const poll = lastPollChange.get(it.project);
  await sendTelegram(
    chatId,
    [
      `📈 <b>${esc(it.project)}</b>`,
      `最新价：$${fmtPrice(it.price)}`,
      `本轮变化：${poll != null ? fmtPct(poll) : "N/A"}`,
      `1H变化：${fmtPct(it.change1h)}`,
      `24H变化：${fmtPct(it.change24h)}`,
      `最高：$${fmtPrice(it.high)}`,
      `最低：$${fmtPrice(it.low)}`,
    ].join("\n"),
  );
}

async function handleCommand(chatId, cmd, args) {
  switch (cmd) {
    case "/start":
    case "/help":
      await sendTelegram(chatId, HELP_TEXT);
      break;
    case "/status":
      await sendTelegram(chatId, statusText());
      break;
    case "/now":
      await cmdNow(chatId);
      break;
    case "/top":
      await cmdTop(chatId);
      break;
    case "/detail":
      await cmdDetail(chatId, args[0]);
      break;
    case "/pause":
      settings.paused = true;
      await sendTelegram(chatId, "⏸ 已暂停自动提醒");
      break;
    case "/resume":
      settings.paused = false;
      await sendTelegram(chatId, "▶️ 已恢复自动提醒");
      break;
    case "/set_interval": {
      const v = parseInt(args[0], 10);
      if (!Number.isFinite(v) || v < 10) {
        await sendTelegram(chatId, "❌ 请输入 ≥10 的秒数，例如 /set_interval 60");
        break;
      }
      settings.pollIntervalSec = v;
      await sendTelegram(chatId, `✅ 查询间隔已设为 ${v}s`);
      break;
    }
    case "/set_poll": {
      const v = parseFloat(args[0]);
      if (!Number.isFinite(v) || v < 0) {
        await sendTelegram(chatId, "❌ 请输入百分比，例如 /set_poll 1");
        break;
      }
      settings.pollAlertPercent = v;
      await sendTelegram(chatId, `✅ 本轮变化阈值已设为 ${v}%`);
      break;
    }
    case "/set_day": {
      const v = parseFloat(args[0]);
      if (!Number.isFinite(v) || v < 0) {
        await sendTelegram(chatId, "❌ 请输入百分比，例如 /set_day 5");
        break;
      }
      settings.dayAlertPercent = v;
      await sendTelegram(chatId, `✅ 24H 变化阈值已设为 ${v}%`);
      break;
    }
    default:
      await sendTelegram(chatId, HELP_TEXT);
  }
}

async function handleUpdate(upd) {
  const msg = upd.message || upd.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  if (!text.startsWith("/")) return;

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase(); // 去掉 @botname
  const args = parts.slice(1);

  if (cmd === "/id") {
    await sendTelegram(chatId, `🆔 Chat ID: <code>${chatId}</code>`);
    return;
  }
  if (!isAuthorized(chatId)) {
    await sendTelegram(
      chatId,
      "⛔ 未授权。请将本 chat_id 配置到 Railway 的 TELEGRAM_CHAT_ID。",
    );
    return;
  }
  try {
    await handleCommand(chatId, cmd, args);
  } catch (e) {
    console.error("[tg] 命令处理出错:", e.message);
    await sendTelegram(chatId, `❌ 出错了：${esc(e.message)}`);
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
      tracked: lastPrices.size,
      uptimeSec: Math.round(process.uptime()),
    }),
  );
  app.listen(PORT, () => console.log(`[http] 监听端口 ${PORT}`));
}

function main() {
  console.log("[boot] Aspecta Telegram Tracker 启动中...");
  console.log(
    `[boot] 间隔=${settings.pollIntervalSec}s 本轮阈值=${settings.pollAlertPercent}% ` +
      `24H阈值=${settings.dayAlertPercent}% 冷却=${settings.cooldownMin}min ` +
      `项目数=${PROJECTS.length}`,
  );
  if (!BOT_TOKEN) console.warn("[boot] 警告：未设置 TELEGRAM_BOT_TOKEN");
  if (!CHAT_ID) console.warn("[boot] 警告：未设置 TELEGRAM_CHAT_ID，自动提醒不会发送");

  startServer();
  telegramPollLoop();
  pollLoop();

  if (BOT_TOKEN && CHAT_ID) {
    sendTelegram(CHAT_ID, "🤖 Aspecta 价格追踪已启动，发送 /help 查看命令");
  }
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
  settings,
};
