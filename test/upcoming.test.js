"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  parseUpcoming,
  isSoon,
  isLaunched,
  parseActiveAssets,
  parseArenaMarkets,
  toNum,
  fmtUsd,
} = require("../index.js");

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

test("parseActiveAssets：从数组/嵌套 asset 取出项目名", () => {
  const names = parseActiveAssets([
    { asset: { name: "GAEA" }, price_change_24h: "0.05" },
    { name: "NEWCOIN", price_change_24h: "0.1" },
    { symbol: "ABC" },
    { foo: "bar" }, // 取不到名字 -> 跳过
  ]);
  assert.deepStrictEqual(names, ["GAEA", "NEWCOIN", "ABC"]);
});

test("parseActiveAssets：空/异常输入返回空数组", () => {
  assert.deepStrictEqual(parseActiveAssets(null), []);
  assert.deepStrictEqual(parseActiveAssets({}), []);
});

test("toNum：数字 / 数字串 / 1e18 定点 / 非法", () => {
  assert.strictEqual(toNum(42), 42);
  assert.strictEqual(toNum("123.5"), 123.5);
  assert.strictEqual(toNum("5000000000000000000"), 5); // 19 位定点 = 5
  assert.strictEqual(toNum(null), null);
  assert.strictEqual(toNum("abc"), null);
});

test("fmtUsd：紧凑金额单位", () => {
  assert.strictEqual(fmtUsd(1_230_000_000), "$1.23B");
  assert.strictEqual(fmtUsd(45_600_000), "$45.60M");
  assert.strictEqual(fmtUsd(7_890), "$7.9K");
  assert.strictEqual(fmtUsd(42), "$42");
  assert.strictEqual(fmtUsd(null), "N/A");
});

test("parseArenaMarkets：取近期成交额(recent_volume)与参与人数", () => {
  const r = parseArenaMarkets({
    data: [
      {
        id: 1,
        asset: { wallet_address: "Veera", total_volume: "415729019751566666011255", participants_count: 2080 },
        recent_volume: "2961264169800000000000",
      },
      { id: 2, asset: { name: "GAEA", participants_count: 120 }, recent_volume: "5000000000000000000000" },
    ],
  });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, "Veera");
  assert.ok(Math.abs(r[0].volume - 2961.26) < 0.1); // recent_volume / 1e18，不取 total_volume
  assert.strictEqual(r[0].participants, 2080);
  assert.strictEqual(r[1].name, "GAEA");
  assert.ok(Math.abs(r[1].volume - 5000) < 0.001);
  assert.strictEqual(r[1].participants, 120);
});

test("parseArenaMarkets：忽略 total/asp 等干扰字段，取不到则 null", () => {
  const r = parseArenaMarkets([
    { name: "X", total_volume: "999000000000000000000000", total_asp_volume: "0" },
  ]);
  assert.strictEqual(r[0].name, "X");
  assert.strictEqual(r[0].volume, null); // 只认 recent_volume，total_volume 不计入
  assert.strictEqual(r[0].participants, null);
});

test("parseArenaMarkets：空/异常输入返回空数组", () => {
  assert.deepStrictEqual(parseArenaMarkets(null), []);
  assert.deepStrictEqual(parseArenaMarkets({}), []);
});
