"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseUpcoming, isSoon, isLaunched } = require("../index.js");

test("parseUpcoming：解析 {data:[...]} 与标准字段", () => {
  const r = parseUpcoming({
    total: 1,
    data: [
      {
        name: "YOM",
        state: "new",
        can_trade: false,
        trade_start_time: "2026-05-25T09:00:00Z",
      },
    ],
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, "YOM");
  assert.strictEqual(r[0].canTrade, false);
  assert.strictEqual(r[0].state, "new");
  assert.strictEqual(r[0].startAt, Date.parse("2026-05-25T09:00:00Z"));
});

test("parseUpcoming：兼容备选字段名（symbol / start_time / canTrade）", () => {
  const r = parseUpcoming([
    { symbol: "ABC", start_time: "2026-06-01T00:00:00Z", canTrade: true },
  ]);
  assert.strictEqual(r[0].name, "ABC");
  assert.strictEqual(r[0].canTrade, true);
  assert.ok(Number.isFinite(r[0].startAt));
});

test("parseUpcoming：从嵌套 asset 取字段", () => {
  const r = parseUpcoming([{ asset: { name: "NEST" }, trade_start_time: "2026-07-01T00:00:00Z" }]);
  assert.strictEqual(r[0].name, "NEST");
});

test("parseUpcoming：缺少开盘时间时 startAt=null，不抛异常", () => {
  const r = parseUpcoming([{ name: "NOTIME" }]);
  assert.strictEqual(r[0].name, "NOTIME");
  assert.strictEqual(r[0].startAt, null);
  assert.strictEqual(r[0].canTrade, false);
});

test("parseUpcoming：空/异常输入返回空数组", () => {
  assert.deepStrictEqual(parseUpcoming(null), []);
  assert.deepStrictEqual(parseUpcoming({}), []);
  assert.deepStrictEqual(parseUpcoming([]), []);
});

test("isSoon：倒计时进入窗口内（未开盘）才为真", () => {
  const now = 1_000_000_000_000;
  const soonMs = 30 * 60 * 1000;
  assert.strictEqual(isSoon({ startAt: now + 20 * 60000 }, now, soonMs), true);
  assert.strictEqual(isSoon({ startAt: now + 40 * 60000 }, now, soonMs), false); // 还太早
  assert.strictEqual(isSoon({ startAt: now - 60000 }, now, soonMs), false); // 已过开盘
  assert.strictEqual(isSoon({ startAt: null }, now, soonMs), false);
});

test("isLaunched：可交易或开盘时间已过为真", () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(isLaunched({ canTrade: true, startAt: now + 99999 }, now), true);
  assert.strictEqual(isLaunched({ canTrade: false, startAt: now - 1 }, now), true);
  assert.strictEqual(isLaunched({ canTrade: false, startAt: now + 60000 }, now), false);
  assert.strictEqual(isLaunched({ canTrade: false, startAt: null }, now), false);
});
