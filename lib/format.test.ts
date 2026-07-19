import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCount,
  formatDurationMinutes,
  formatMinute,
  formatMinuteSquared,
  formatPercent,
  formatPp,
  formatSignedInt,
  formatYesNo,
} from "./format.ts";

test("formatMinute rounds to the nearest whole minute with an apostrophe", () => {
  assert.equal(formatMinute(101.71666666666667), "102'");
  assert.equal(formatMinute(75), "75'");
  assert.equal(formatMinute(74.4), "74'");
});

test("formatMinuteSquared comma-groups with exactly two decimal places", () => {
  assert.equal(formatMinuteSquared(10346.280277777778), "10,346.28");
  assert.equal(formatMinuteSquared(225), "225.00");
});

test("formatCount renders an integer with no decimal point", () => {
  assert.equal(formatCount(2), "2");
  assert.equal(formatCount(2.0), "2");
});

test("formatSignedInt is a signed integer -- +1, 0, -1", () => {
  assert.equal(formatSignedInt(1), "+1");
  assert.equal(formatSignedInt(0), "0");
  assert.equal(formatSignedInt(-1), "-1");
});

test("formatYesNo renders the 0/1 model flag as a human answer", () => {
  assert.equal(formatYesNo(1), "Yes");
  assert.equal(formatYesNo(0), "No");
});

test("formatDurationMinutes is one decimal place plus unit", () => {
  assert.equal(formatDurationMinutes(10.25), "10.3 minutes");
  assert.equal(formatDurationMinutes(0), "0.0 minutes");
});

test("formatPercent (existing) already matches the one-decimal-place spec", () => {
  assert.equal(formatPercent(0.97234), "97.2%");
});

test("formatPp (existing) already matches the '+X.Xpp' spec", () => {
  assert.equal(formatPp(6.04), "+6.0pp");
  assert.equal(formatPp(-2.1), "-2.1pp");
});

test("none of these formatters ever emit ten or more decimal digits", () => {
  const longDecimalPattern = /\.\d{10,}/;
  assert.ok(!longDecimalPattern.test(formatMinute(101.71666666666667)));
  assert.ok(!longDecimalPattern.test(formatMinuteSquared(10346.280277777778)));
  assert.ok(!longDecimalPattern.test(formatDurationMinutes(10.256789123)));
});
