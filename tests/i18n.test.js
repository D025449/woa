import assert from "node:assert/strict";
import test from "node:test";

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

test("i18n middleware serves every discovered locale from the startup bundle cache", () => {
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
