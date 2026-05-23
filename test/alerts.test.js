"use strict";

const test = require("node:test");
const assert = require("node:assert");
const app = require("../index.js");
const {
  settings,
  _state,
  evalDayAlert,
  canAlertKey,
  alertBlock,
  batchedMessage,
  startupSnapshot,
} = app;

test("24H 边沿触发 + 回滞 + 冷启动", () => {
  settings.dayAlertPercent = 5;
  settings.dayRearmPercent = 4;
  _state.dayState.clear();
  const P = "T";
  // 冷启动：首次已超阈值，只建基线，不报
  assert.strictEqual(evalDayAlert(P, 8), false);
  // 仍在阈值上方，不重复报
  assert.strictEqual(evalDayAlert(P, 9), false);
  // 回落到回滞线(4%)内 → 重新武装，不报
  assert.strictEqual(evalDayAlert(P, 3.5), false);
  // 再次穿越 5% → 报
  assert.strictEqual(evalDayAlert(P, 6), true);
  // 停在 4%~5% 之间（> rearm）→ 不重新武装，不报
  assert.strictEqual(evalDayAlert(P, 4.5), false);
  // 未回到 4% 内，重新到 6% 不应再次触发
  assert.strictEqual(evalDayAlert(P, 6), false);
});

test("冷启动落在阈值内：之后穿越才报", () => {
  settings.dayAlertPercent = 5;
  settings.dayRearmPercent = 4;
  _state.dayState.clear();
  const P = "U";
  assert.strictEqual(evalDayAlert(P, 1), false); // 基线：已武装
  assert.strictEqual(evalDayAlert(P, 6), true); // 穿越
});

test("项目级冷却：同项目短时间内只放行一次（poll/day 合并只发一次）", () => {
  settings.cooldownMin = 30;
  _state.alertCooldown.clear();
  assert.strictEqual(canAlertKey("P:any"), true);
  assert.strictEqual(canAlertKey("P:any"), false);
});

test("alertBlock 隐藏无数据行并带方向图标", () => {
  settings.pollLookbackSec = 0;
  const b = alertBlock(
    { project: "X", price: 2.46, change1h: null, change24h: -5.23 },
    null,
    ["24H"],
  );
  assert.ok(b.includes("📉"), "下跌箭头");
  assert.ok(b.includes("🔴"), "红点");
  assert.ok(!b.includes("本轮"), "无 pollChange 时隐藏本轮行");
  assert.ok(!b.includes("1H"), "无 change1h 时隐藏 1H");
});

test("batchedMessage：单条无头部，多条带计数头并按幅度排序", () => {
  const one = batchedMessage([
    { item: { project: "A", price: 1, change1h: 1, change24h: 6 }, pollChange: 1, reasons: ["24H"] },
  ]);
  assert.ok(!one.includes("异动"), "单条不带头部");

  const many = batchedMessage([
    { item: { project: "A", price: 1, change1h: 1, change24h: 6 }, pollChange: 1, reasons: ["24H"] },
    { item: { project: "B", price: 1, change1h: 1, change24h: 9 }, pollChange: 1, reasons: ["24H"] },
  ]);
  assert.ok(many.includes("异动 ×2"), "多条带计数头");
  assert.ok(
    many.indexOf("<b>B</b>") < many.indexOf("<b>A</b>"),
    "9% 的 B 排在 6% 的 A 前面",
  );
});

test("startupSnapshot 仅列出超阈值项目", () => {
  settings.dayAlertPercent = 5;
  const s = startupSnapshot([
    { ok: true, project: "GAEA", price: 2.17, change24h: 11.89 },
    { ok: true, project: "X", price: 1, change24h: 2 },
  ]);
  assert.ok(s.includes("GAEA"), "异动项目列出");
  assert.ok(!s.includes("<b>X</b>"), "阈值内项目不列出");
});
