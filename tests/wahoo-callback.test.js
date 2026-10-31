import test from "node:test";
import assert from "node:assert/strict";
import { wahooCallbackPlaceholder } from "../src/routes/wahooRoutes.js";

test("Wahoo placeholder discards OAuth parameters and redirects to a fixed notice without caching", () => {
  const headers = {};
  let target;
  const req = { get query() { throw new Error("OAuth parameters must not be consumed"); } };
  wahooCallbackPlaceholder(req, {
    set(name, value) { headers[name] = value; },
    redirect(value) { target = value; }
  });
  assert.equal(target, "/profile?wahoo=not-configured#wahoo-notice");
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
});
