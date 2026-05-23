"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseSnapshot, toPrice, esc } = require("../index.js");

const E18 = (n) => `${n}000000000000000000`; // n * 1e18 的整数字符串

test("toPrice：18 位定点，精确还原（含超过 2^53 的大整数）", () => {
  assert.strictEqual(toPrice("2000000000000000000"), 2);
  assert.strictEqual(toPrice("2195000000000000000"), 2.195);
  assert.strictEqual(toPrice("851754000000000000"), 0.851754);
  assert.strictEqual(toPrice(null), null);
});

test("parseSnapshot：空 k_line 标记 ok=false", () => {
  const r = parseSnapshot([{ project_address: "E", k_line: [] }]);
  assert.strictEqual(r[0].ok, false);
});

test("parseSnapshot：单根 K 线时 change1h 为 null，change24h 用开盘价", () => {
  const r = parseSnapshot([
    {
      project_address: "S",
      k_line: [
        { open_price: E18(1), close_price: "1100000000000000000", high_price: "1200000000000000000", low_price: "900000000000000000", ended_at: 1 },
      ],
    },
  ]);
  assert.strictEqual(r[0].ok, true);
  assert.strictEqual(r[0].change1h, null);
  assert.ok(Math.abs(r[0].change24h - 10) < 1e-9); // (1.1-1.0)/1.0*100
});

test("parseSnapshot：24H 最高/最低取所有 K 线的极值", () => {
  const r = parseSnapshot([
    {
      project_address: "H",
      k_line: [
        { open_price: E18(1), close_price: E18(1), high_price: "1500000000000000000", low_price: "800000000000000000", ended_at: 1 },
        { open_price: E18(1), close_price: "1200000000000000000", high_price: "1300000000000000000", low_price: "700000000000000000", ended_at: 2 },
      ],
    },
  ]);
  assert.ok(Math.abs(r[0].high24h - 1.5) < 1e-9);
  assert.ok(Math.abs(r[0].low24h - 0.7) < 1e-9);
});

test("parseSnapshot：缺字段不抛异常", () => {
  const r = parseSnapshot([
    { project_address: "M", k_line: [{ close_price: E18(1), ended_at: 1 }] },
  ]);
  assert.strictEqual(r[0].ok, true);
  assert.strictEqual(r[0].change24h, null); // 没有 open_price
  assert.strictEqual(r[0].high24h, null);
});

test("parseSnapshot：支持 {data:[...]} 包裹形式", () => {
  const r = parseSnapshot({ data: [{ project_address: "W", k_line: [] }] });
  assert.strictEqual(r.length, 1);
});

test("esc：转义 HTML 特殊字符，避免破坏 parse_mode=HTML", () => {
  assert.strictEqual(esc("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});
