import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startAll, waitForApp } from "../src/scripts/start-all.js";

const entries = [["app", new URL("../src/index.js", import.meta.url)]];
const ngrokUrl = "https://scenic-riverbed-unloader.ngrok-free.dev";

function harness(t, options = {}) {
  const calls = [];
  const previousExitCode = process.exitCode;
  const stop = startAll(entries, {
    environment: { NODE_ENV: "development" },
    ...options,
    spawnProcess(command, args, launchOptions) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.signals = [];
      child.kill = (signal) => child.signals.push(signal);
      calls.push({ command, args, child, env: { ...launchOptions.env } });
      return child;
    }
  });
  t.after(() => {
    stop(0);
    for (const { child } of calls) {
      child.stdout.end();
      child.stderr.end();
      child.emit("close");
    }
    process.exitCode = previousExitCode;
  });
  return { calls, stop };
}

test("start:all starts only Node services without requesting a tunnel", (t) => {
  const { calls } = harness(t, {
    waitForReady() { assert.fail("No readiness probe expected"); }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
});

test("local startup overrides inherited redirect URLs without changing the source environment", (t) => {
  const environment = {
    APP_BASE_URL: ngrokUrl,
    COGNITO_REDIRECT_URI: `${ngrokUrl}/auth/callback`,
    WAHOO_REDIRECT_URI: `${ngrokUrl}/auth/wahoo/callback`,
    WAHOO_CLIENT_ID: "test-client",
    WAHOO_CLIENT_SECRET: "test-only-secret",
    WAHOO_TOKEN_ENCRYPTION_KEY: "test-only-key",
    WAHOO_WEBHOOK_TOKEN: "test-only-webhook-token"
  };
  const original = { ...environment };
  const { calls } = harness(t, { environment });
  assert.deepEqual(calls[0].env, {
    ...original,
    APP_BASE_URL: "http://localhost:3000",
    COGNITO_REDIRECT_URI: "http://localhost:3000/auth/callback",
    PORT: "3000"
  });
  assert.deepEqual(environment, original);
});

test("local startup uses the configured app port for redirects", (t) => {
  const { calls } = harness(t, { environment: { NODE_ENV: "development", PORT: "4321" } });
  assert.equal(calls[0].env.APP_BASE_URL, "http://localhost:4321");
  assert.equal(calls[0].env.COGNITO_REDIRECT_URI, "http://localhost:4321/auth/callback");
});

test("tunnel startup sets public redirects for every service and keeps Wahoo unchanged", async (t) => {
  const environment = {
    NODE_ENV: "development",
    PORT: "4321",
    APP_BASE_URL: "http://localhost:3000",
    COGNITO_REDIRECT_URI: "http://localhost:3000/auth/callback",
    WAHOO_REDIRECT_URI: `${ngrokUrl}/auth/wahoo/callback`
  };
  const original = { ...environment };
  const { calls } = harness(t, {
    environment,
    ngrokUrl,
    waitForReady: async (port) => { assert.equal(port, "4321"); }
  });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  for (const { env } of calls) {
    assert.deepEqual(env, {
      ...original,
      APP_BASE_URL: ngrokUrl,
      COGNITO_REDIRECT_URI: `${ngrokUrl}/auth/callback`
    });
  }
  assert.deepEqual(calls[1].args, ["http", "4321", "--url", ngrokUrl]);
  assert.deepEqual(environment, original);
});

test("production startup preserves configured URLs", (t) => {
  const environment = {
    NODE_ENV: "production",
    APP_BASE_URL: "https://example.com",
    COGNITO_REDIRECT_URI: "https://example.com/auth/callback",
    WAHOO_REDIRECT_URI: "https://example.com/auth/wahoo/callback"
  };
  const { calls } = harness(t, { environment, ngrokUrl, waitForReady: async () => {} });
  assert.deepEqual(calls[0].env, environment);
});

test("tunnel waits for readiness, uses the selected port and stops with the app", async (t) => {
  let ready;
  const { calls, stop } = harness(t, {
    ngrokUrl,
    port: 4321,
    waitForReady(port, signal) {
      assert.equal(port, 4321);
      assert.equal(signal.aborted, false);
      return new Promise((resolve) => { ready = resolve; });
    }
  });
  assert.equal(calls.length, 1);
  ready();
  await new Promise(setImmediate);
  assert.equal(calls[1].command, "ngrok");
  assert.deepEqual(calls[1].args, ["http", "4321", "--url", ngrokUrl]);
  stop(0, "SIGINT");
  for (const { child } of calls) assert.deepEqual(child.signals, ["SIGINT"]);
});

test("ngrok startup and exit failures leave local services running", async (t) => {
  const { calls } = harness(t, { ngrokUrl, waitForReady: async () => {} });
  await new Promise(setImmediate);
  calls[1].child.emit("error", new Error("spawn ngrok ENOENT"));
  calls[1].child.emit("exit", 1, null);
  assert.deepEqual(calls[0].child.signals, []);
});

test("failed readiness leaves local services running without ngrok", async (t) => {
  const { calls } = harness(t, {
    ngrokUrl,
    waitForReady: async () => { throw new Error("timeout"); }
  });
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].child.signals, []);
});

test("shutdown cancels readiness and never starts a late tunnel", async (t) => {
  let ready;
  let readinessSignal;
  const { calls, stop } = harness(t, {
    ngrokUrl,
    waitForReady(port, signal) {
      readinessSignal = signal;
      return new Promise((resolve) => { ready = resolve; });
    }
  });
  stop(0);
  assert.equal(readinessSignal.aborted, true);
  ready();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
});

test("a core service failure still stops the other processes", async (t) => {
  const { calls } = harness(t, { ngrokUrl, waitForReady: async () => {} });
  await new Promise(setImmediate);
  calls[0].child.emit("exit", 1, null);
  assert.deepEqual(calls[1].child.signals, ["SIGTERM"]);
});

test("readiness retries server errors and accepts a login redirect", async (t) => {
  let requests = 0;
  const server = createServer((request, response) => {
    response.writeHead(++requests === 1 ? 503 : 302, { Location: "/login" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await waitForApp(address.port, new AbortController().signal);
  assert.equal(requests, 2);
});

test("readiness respects cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForApp(1, controller.signal), { name: "AbortError" });
});