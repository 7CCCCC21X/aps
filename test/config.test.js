"use strict";

// 必须在 require 之前设置环境变量（每个测试文件在独立进程中运行）
process.env.ALERT_COOLDOWN_MIN = "7";
process.env.DAY_ALERT_PERCENT = "6";
process.env.POLL_LOOKBACK_SEC = "120";

const test = require("node:test");
const assert = require("node:assert");
const app = require("../index.js");

test("ALERT_COOLDOWN_MIN 环境变量生效（修复前会被默认值覆盖）", () => {
  assert.strictEqual(app.settings.cooldownMin, 7);
});

test("DAY_REARM_PERCENT 默认 = 24H 阈值 - 1", () => {
  assert.strictEqual(app.settings.dayRearmPercent, 5); // 6 - 1
});

test("POLL_LOOKBACK_SEC 环境变量生效", () => {
  assert.strictEqual(app.settings.pollLookbackSec, 120);
});

test("无管理员配置时 isAdminUser 默认放行", () => {
  assert.strictEqual(app.isAdminUser("123"), true);
});
