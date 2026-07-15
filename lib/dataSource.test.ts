import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getConfiguredDataSource, assertTxLineCredentials, TxLineConfigError } from "./dataSource.ts";

const ENV_KEYS = ["TXLINE_DATA_SOURCE", "TXLINE_API_TOKEN"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("defaults to demo when TXLINE_DATA_SOURCE is absent", () => {
  assert.equal(getConfiguredDataSource(), "demo");
});

test("defaults to demo for an unrecognized value", () => {
  process.env.TXLINE_DATA_SOURCE = "bogus";
  assert.equal(getConfiguredDataSource(), "demo");
});

test("recognizes txline when explicitly configured", () => {
  process.env.TXLINE_DATA_SOURCE = "txline";
  assert.equal(getConfiguredDataSource(), "txline");
});

test("assertTxLineCredentials is a no-op in demo mode even without a token", () => {
  assert.doesNotThrow(() => assertTxLineCredentials());
});

test("assertTxLineCredentials throws a clear config error when txline mode has no token", () => {
  process.env.TXLINE_DATA_SOURCE = "txline";
  assert.throws(() => assertTxLineCredentials(), TxLineConfigError);
});

test("the config error message never contains a credential value", () => {
  process.env.TXLINE_DATA_SOURCE = "txline";
  try {
    assertTxLineCredentials();
    assert.fail("expected assertTxLineCredentials to throw");
  } catch (err) {
    assert.ok(err instanceof TxLineConfigError);
    // The message should explain what's missing without ever including a
    // secret value (there is none configured, and it must stay that way).
    assert.doesNotMatch(err.message, /txoracle_api_/);
  }
});

test("assertTxLineCredentials does not throw once a token is present", () => {
  process.env.TXLINE_DATA_SOURCE = "txline";
  process.env.TXLINE_API_TOKEN = "placeholder-token";
  assert.doesNotThrow(() => assertTxLineCredentials());
});
