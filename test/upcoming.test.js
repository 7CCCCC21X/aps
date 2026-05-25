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

test("parseArenaMarkets：自动探测市值/成交量字段", () => {
  const r = parseArenaMarkets({
    data: [
      { name: "AAA", market_cap: "50000000", volume_24h: "1200000" },
      { symbol: "BBB", mcap: 8_000_000, turnover: 50_000 },
      { asset: { name: "CCC" }, fdv: "3000000", volumeUsd: "9000" },
    ],
  });
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], { name: "AAA", marketCap: 50000000, volume: 1200000 });
  assert.deepStrictEqual(r[1], { name: "BBB", marketCap: 8000000, volume: 50000 });
  assert.deepStrictEqual(r[2], { name: "CCC", marketCap: 3000000, volume: 9000 });
});

test("parseArenaMarkets：忽略 rank/百分比类字段，取不到则 null", () => {
  const r = parseArenaMarkets([
    { name: "X", market_cap_rank: 3, price_change_24h: "0.1" },
  ]);
  assert.strictEqual(r[0].name, "X");
  assert.strictEqual(r[0].marketCap, null);
  assert.strictEqual(r[0].volume, null);
});

test("parseArenaMarkets：空/异常输入返回空数组", () => {
  assert.deepStrictEqual(parseArenaMarkets(null), []);
  assert.deepStrictEqual(parseArenaMarkets({}), []);
});
