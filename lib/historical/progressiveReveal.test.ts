import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleThrough } from "./progressiveReveal.ts";

const POINTS = [
  { minute: 60, value: "a" },
  { minute: 61, value: "b" },
  { minute: 62, value: "c" },
  { minute: 70, value: "goal" },
  { minute: 75, value: "d" },
  { minute: 80, value: "e" },
];

test("visibleThrough excludes every point after currentMinute -- future points are absent, not merely hidden", () => {
  const visible = visibleThrough(POINTS, 62);
  assert.deepEqual(
    visible.map((p) => p.minute),
    [60, 61, 62],
  );
  assert.ok(!visible.some((p) => p.minute > 62), "no point past currentMinute may be present in the output at all");
});

test("advancing currentMinute by exactly one reveals exactly one additional point", () => {
  const before = visibleThrough(POINTS, 61);
  const after = visibleThrough(POINTS, 62);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before, "all previously-visible points remain, in the same order (pre-goal/earlier history is preserved)");
});

test("currentMinute below every point's minute reveals nothing yet", () => {
  assert.deepEqual(visibleThrough(POINTS, 10), []);
});

test("currentMinute at or above the last point reveals everything, and calling it again (a rerender) returns the identical set", () => {
  const first = visibleThrough(POINTS, 80);
  const second = visibleThrough(POINTS, 80);
  assert.deepEqual(first, second);
  assert.equal(first.length, POINTS.length);
});

test("visibleThrough never mutates the input array", () => {
  const original = [...POINTS];
  visibleThrough(POINTS, 62);
  assert.deepEqual(POINTS, original);
});

test("visibleThrough is generic over any minute-shaped point, e.g. goal markers", () => {
  const goals = [{ minute: 70, team: "home" as const }];
  assert.deepEqual(visibleThrough(goals, 69), []);
  assert.deepEqual(visibleThrough(goals, 70), goals);
});
