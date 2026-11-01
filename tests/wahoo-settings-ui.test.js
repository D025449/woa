import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/public/js/wahoo-settings-ui.js", import.meta.url), "utf8").replace(/^import .*;\n/, "");
class Element {
  textContent = "connect";
  checked = false;
  disabled = false;
  handlers = {};
  addEventListener(name, fn) { this.handlers[name] = fn; }
}
async function setup(data) {
  const elements = Object.fromEntries(["connect", "remove", "status", "feedback", "auto-import", "auto-import-help", "settings-messages"].map(key => [`wahoo-${key}`, new Element()]));
  const messages = { configured: "connected", empty: "empty", unavailable: "unavailable", error: "error", reconnect: "reconnect", offlineRequired: "offline required", webhookUnavailable: "server unavailable", autoImportHelp: "help", autoImportSaved: "saved" };
  elements["wahoo-settings-messages"].textContent = JSON.stringify(messages);
  const events = {};
  const calls = [];
  let fail = false;
  const context = { document: { getElementById: id => elements[id] }, window: { addEventListener: (name, fn) => { events[name] = fn; } },
    URL, URLSearchParams, location: { search: "" }, confirmModal: async () => true,
    fetch: async (url, options) => { calls.push([url, options]); return { ok: !fail, status: url.endsWith("status") ? 200 : 204, json: async () => ({ data }) }; }
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  events["profile-account-state"]({ detail: "active" });
  return { elements, events, calls, fail: () => { fail = true; } };
}

test("Wahoo profile offers renewed authorization and prevents toggling until authorized", async () => {
  const { elements } = await setup({ configured: true, available: true, offlineDataGranted: false, webhookAvailable: true });
  assert.equal(elements["wahoo-connect"].disabled, false);
  assert.equal(elements["wahoo-connect"].textContent, "reconnect");
  assert.equal(elements["wahoo-auto-import"].disabled, true);
  assert.equal(elements["wahoo-auto-import-help"].textContent, "offline required");
});

test("Wahoo toggle persists the preference, restores failed changes and respects read-only accounts", async () => {
  const { elements, events, calls, fail } = await setup({ configured: true, available: true, offlineDataGranted: true, webhookAvailable: true, autoImportEnabled: false });
  const toggle = elements["wahoo-auto-import"];
  assert.equal(toggle.disabled, false);
  toggle.checked = true;
  await toggle.handlers.change();
  assert.equal(toggle.checked, true);
  assert.equal(calls.at(-1)[0], "/auth/wahoo/auto-import");
  assert.equal(calls.at(-1)[1].method, "PUT");
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { enabled: true });
  fail(); toggle.checked = false;
  await toggle.handlers.change();
  assert.equal(toggle.checked, true);
  assert.equal(elements["wahoo-feedback"].textContent, "error");
  events["profile-account-state"]({ detail: "pending_deletion" });
  assert.equal(toggle.disabled, true);
});
