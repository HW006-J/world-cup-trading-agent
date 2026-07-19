import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_HERO_FIXTURE_ID, PRIMARY_HERO_FIXTURE_ID, resolveHeroFixtureId } from "./heroFixture.ts";

test("resolveHeroFixtureId prefers the primary hero fixture when it's available", () => {
  assert.equal(resolveHeroFixtureId(["1", PRIMARY_HERO_FIXTURE_ID, "2"]), PRIMARY_HERO_FIXTURE_ID);
});

test("resolveHeroFixtureId falls back to the bundled fixture when the primary isn't available (e.g. a fresh clone)", () => {
  assert.equal(resolveHeroFixtureId([FALLBACK_HERO_FIXTURE_ID]), FALLBACK_HERO_FIXTURE_ID);
});

test("resolveHeroFixtureId falls back to the first available fixture when neither expected id is present", () => {
  assert.equal(resolveHeroFixtureId(["unexpected-1", "unexpected-2"]), "unexpected-1");
});

test("resolveHeroFixtureId returns null when there are genuinely zero fixtures", () => {
  assert.equal(resolveHeroFixtureId([]), null);
});

test("resolveHeroFixtureId prefers the primary even when the fallback is also present", () => {
  assert.equal(resolveHeroFixtureId([FALLBACK_HERO_FIXTURE_ID, PRIMARY_HERO_FIXTURE_ID]), PRIMARY_HERO_FIXTURE_ID);
});
