import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.listeners = {}; this.checked = false; this.hidden = false; this.value = ""; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
  reportValidity() { return true; }
  async dispatch(event) { await this.listeners[event]?.({ preventDefault() {} }); }
}

test("API key UI explicitly selects FIT dependencies and never grants FIT to existing keys", async () => {
  const ids = ["api-keys-form", "api-keys-messages", "api-key-name", "api-key-read", "api-key-gps", "api-key-fit", "api-key-analytics", "api-key-create",
    "api-keys-refresh", "api-keys-feedback", "api-keys-list", "api-key-secret-panel", "api-key-secret", "api-key-show", "api-keys-limits",
    "api-keys-empty", "api-key-dismiss", "api-key-copy"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const messages = JSON.parse(fs.readFileSync(new URL("../src/public/i18n/en.json", import.meta.url), "utf8")).profile.apiKeys;
  elements["api-keys-messages"].textContent = JSON.stringify({ ...messages, locale: "en" });
  elements["api-key-read"].checked = true;
  const oldKey = { id: "1", name: "Old GPS key", prefix: "fixture", status: "active", scopes: ["workouts:read", "workouts:gps:read"] };
  const requests = [];
  const source = fs.readFileSync(new URL("../src/public/js/api-keys-ui.js", import.meta.url), "utf8")
    .replace('import confirmModal from "./confirm-modal.js";', 'const confirmModal = async () => false;');
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id], createElement: tag => new Element(tag) },
    window: new Element(), navigator: {}, fetch: async (path, options) => {
      if (options.method === "POST") {
        const input = JSON.parse(options.body); requests.push(input);
        return { ok: true, status: 201, json: async () => ({ data: { key: { ...oldKey, id: "2", name: input.name, scopes: input.scopes }, secret: "fixture-only" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ csrfToken: "fixture", data: { keys: [oldKey], canCreate: true,
        limits: { maxActiveKeys: 5, lifetimeDays: 90 } } }) };
    }
  });
  await new Promise(setImmediate);
  const read = elements["api-key-read"], gps = elements["api-key-gps"], fit = elements["api-key-fit"];
  assert.equal(fit.checked, false);
  assert.equal(elements["api-keys-list"].children[0].children[1].textContent, messages.readScope + " / " + messages.gpsScope);
  fit.checked = true; await fit.dispatch("change");
  assert.equal(read.checked, true); assert.equal(gps.checked, true);
  gps.checked = false; await gps.dispatch("change"); assert.equal(fit.checked, false);
  fit.checked = true; await fit.dispatch("change");
  read.checked = false; await read.dispatch("change");
  assert.equal(gps.checked, false); assert.equal(fit.checked, false);
  assert.equal(elements["api-key-create"].disabled, true);
  fit.checked = true; await fit.dispatch("change");
  elements["api-key-name"].value = "FIT client";
  await elements["api-keys-form"].dispatch("submit");
  assert.deepEqual(requests[0], { name: "FIT client", scopes: ["workouts:read", "workouts:gps:read", "workouts:fit:read"] });
  assert.equal(elements["api-key-secret"].value, "fixture-only");
  assert.equal(elements["api-key-fit"].disabled, true);
  const labels = elements["api-keys-list"].children[0].children[1].textContent;
  assert.ok(labels.includes(messages.fitScope));
  await elements["api-key-dismiss"].dispatch("click");
  assert.equal(elements["api-key-secret"].value, "");
  assert.equal(elements["api-key-secret-panel"].hidden, true);
  read.checked = false; await read.dispatch("change");
  const analytics = elements["api-key-analytics"];
  assert.equal(analytics.checked, false);
  assert.equal(elements["api-key-create"].disabled, true);
  analytics.checked = true; await analytics.dispatch("change");
  assert.equal(elements["api-key-create"].disabled, false);
  assert.equal(read.checked, false); assert.equal(gps.checked, false); assert.equal(fit.checked, false);
  elements["api-key-name"].value = "Analytics client";
  await elements["api-keys-form"].dispatch("submit");
  assert.deepEqual(requests[1], { name: "Analytics client", scopes: ["analytics:read"] });
  assert.equal(elements["api-keys-list"].children[0].children[1].textContent, messages.analyticsScope);
});
