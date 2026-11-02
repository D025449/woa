import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createI18nMiddleware,
  getSupportedLocales
} from "../src/i18n/index.js";

function runMiddleware(middleware, {
  query = {},
  cookies = {},
  session = {},
  headers = {}
} = {}) {
  const req = { query, cookies, session, headers };
  const res = {
    locals: {},
    cookie() {}
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  return res.locals;
}

test("i18n middleware serves every discovered locale from the bundle cache", () => {
  const middleware = createI18nMiddleware();

  for (const locale of getSupportedLocales()) {
    const locals = runMiddleware(middleware, {
      query: { lang: locale },
      headers: {}
    });
    assert.equal(locals.locale, locale);
    assert.equal(typeof locals.messages.dashboardNewPage?.title, "string");
    assert.equal(locals.i18n.messages, locals.messages);
  }
});

test("i18n middleware still falls back to English for unsupported locales", () => {
  const locals = runMiddleware(createI18nMiddleware(), {
    query: { lang: "xx" },
    headers: {}
  });

  assert.equal(locals.locale, "en");
  assert.equal(locals.messages.dashboardNewPage.title, "Workouts");
});

let fixtureId = 0;

async function createReloadFixture(context, environment) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woa-i18n-"));
  const originalEnvironment = process.env.NODE_ENV;
  if (environment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = environment;
  context.after(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const write = (locale, messages) => {
    fs.writeFileSync(path.join(directory, `${locale}.json`), JSON.stringify(messages));
  };
  write("en", { label: "English before" });
  write("de", { label: "German before" });

  const sourceDirectory = fileURLToPath(new URL("../src/public/i18n", import.meta.url));
  const redirect = filePath => {
    if (filePath === sourceDirectory) return directory;
    if (typeof filePath === "string" && path.dirname(filePath) === sourceDirectory) {
      return path.join(directory, path.basename(filePath));
    }
    return filePath;
  };
  const counts = { readdirSync: 0, statSync: 0, readFileSync: 0 };
  for (const method of ["readdirSync", "statSync", "readFileSync"]) {
    const original = fs[method];
    context.mock.method(fs, method, (filePath, ...args) => {
      const redirected = redirect(filePath);
      if (redirected !== filePath) counts[method] += 1;
      return original.call(fs, redirected, ...args);
    });
  }
  const warnings = [];
  context.mock.method(console, "warn", message => warnings.push(message));
  const i18n = await import(`../src/i18n/index.js?reload-fixture=${++fixtureId}`);
  return { directory, write, counts, warnings, i18n };
}

test("development and unset environments reload changes without rebuilding middleware", async context => {
  for (const environment of ["development", undefined]) {
    await context.test(String(environment), async subcontext => {
      const fixture = await createReloadFixture(subcontext, environment);
      const middleware = fixture.i18n.createI18nMiddleware();
      const before = runMiddleware(middleware);
      assert.equal(before.t("label"), "English before");
      const initialReads = fixture.counts.readFileSync;
      runMiddleware(middleware);
      assert.equal(fixture.counts.readFileSync, initialReads);

      fixture.write("en", { label: "English after editing", added: "New key" });
      const after = runMiddleware(middleware);
      assert.equal(after.t("label"), "English after editing");
      assert.equal(after.t("added"), "New key");
      assert.equal(before.t("label"), "English before");
      assert.ok(fixture.counts.readFileSync > initialReads);
      const reloadedReads = fixture.counts.readFileSync;
      runMiddleware(middleware);
      assert.equal(fixture.counts.readFileSync, reloadedReads);
    });
  }
});

test("development publishes locale additions and removals with their bundles", async context => {
  const fixture = await createReloadFixture(context, "development");
  const middleware = fixture.i18n.createI18nMiddleware();
  fixture.write("fr", { label: "French added" });
  const added = runMiddleware(middleware, { headers: { "accept-language": "fr" } });
  assert.equal(added.locale, "fr");
  assert.equal(added.t("label"), "French added");
  assert.ok(added.supportedLocales.includes("fr"));

  fs.unlinkSync(path.join(fixture.directory, "de.json"));
  const removed = runMiddleware(middleware, { query: { lang: "de" } });
  assert.equal(removed.locale, "en");
  assert.equal(removed.supportedLocales.includes("de"), false);
  assert.equal(fixture.i18n.normalizeSupportedLocale("de"), "en");
});

test("invalid JSON preserves all previous bundles, warns once, and recovers after correction", async context => {
  const fixture = await createReloadFixture(context, "development");
  const middleware = fixture.i18n.createI18nMiddleware();
  fixture.write("en", { label: "English pending update" });
  fs.writeFileSync(path.join(fixture.directory, "de.json"), '{"private":"do-not-log",');
  assert.equal(runMiddleware(middleware).t("label"), "English before");
  assert.equal(runMiddleware(middleware, { query: { lang: "de" } }).t("label"), "German before");
  assert.equal(fixture.warnings.length, 1);
  assert.doesNotMatch(fixture.warnings[0], /do-not-log/);

  fixture.write("de", { label: "German corrected" });
  assert.equal(runMiddleware(middleware).t("label"), "English pending update");
  assert.equal(runMiddleware(middleware, { query: { lang: "de" } }).t("label"), "German corrected");

  fs.unlinkSync(path.join(fixture.directory, "en.json"));
  assert.equal(runMiddleware(middleware).t("label"), "English pending update");
  assert.equal(fixture.warnings.length, 2);
});

test("invalid startup JSON still fails when no valid cache exists", async context => {
  const fixture = await createReloadFixture(context, "development");
  fs.writeFileSync(path.join(fixture.directory, "en.json"), "{");
  assert.throws(() => fixture.i18n.createI18nMiddleware(), SyntaxError);
});

test("production and other explicit environments retain startup bundles without filesystem checks", async context => {
  for (const environment of ["production", "test"]) {
    await context.test(environment, async subcontext => {
      const fixture = await createReloadFixture(subcontext, environment);
      const middleware = fixture.i18n.createI18nMiddleware();
      const counts = { ...fixture.counts };
      fixture.write("en", { label: "Not visible until restart" });
      fixture.write("fr", { label: "Not discovered until restart" });
      const locals = runMiddleware(middleware);
      assert.equal(locals.t("label"), "English before");
      assert.equal(locals.supportedLocales.includes("fr"), false);
      assert.deepEqual(fixture.counts, counts);
    });
  }
});
