import test from "node:test";
import assert from "node:assert/strict";
import { initializeGarminImport } from "../src/public/js/garmin-import-ui.js";

class Element {
  children = [];
  listeners = {};
  textContent = "";
  checked = false;
  disabled = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  async click() { await this.listeners.click(); }
}

test("Garmin selection processes archives sequentially, reports per-item failures and preserves retry selection", async t => {
  const elements = Object.fromEntries(["garmin-load", "garmin-load-more", "garmin-activities", "garmin-import-status", "garmin-import-selected", "garmin-import-messages"].map(id => [id, new Element()]));
  const texts = { choose: "choose", running: "running", downloading: "downloading", processing: "processing", imported: "imported", failed: "failed", partial: "partial", done: "done" };
  elements["garmin-import-messages"].textContent = JSON.stringify(texts);
  const previous = globalThis.document;
  globalThis.document = { getElementById: id => elements[id], createElement: () => new Element() };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url.endsWith("activities")) return new Response(JSON.stringify({ data: [1, 2, 3].map(id => ({ id: String(id), name: "<script>untrusted</script>", sport: "cycling", duration: 600, startTime: "2026-10-30 12:00:00" })) }));
    if (url.includes("/2/")) return new Response(JSON.stringify({diagnostic:{stage:"download",upstreamStatus:400,technicalCode:"HTTP_ERROR"}}), { status: 502 });
    return new Response(Buffer.from([0x50, 0x4b, 3, 4]));
  });
  let busy = false;
  const imported = [];
  initializeGarminImport({ isBusy: () => busy, setBusy: value => { busy = value; }, importFile: async file => {
    assert.equal(busy, true);
    assert.equal(elements["garmin-load"].disabled, true);
    imported.push(file.name);
    assert.equal(file.size, 4);
    return { status: file.name === "1.zip" ? "failed" : "imported" };
  } });
  await elements["garmin-load"].click();
  const list = elements["garmin-activities"];
  assert.equal(list.children.length, 3);
  for (const item of list.children) item.children[0].children[0].checked = true;
  await elements["garmin-import-selected"].click();
  assert.deepEqual(imported, ["1.zip", "3.zip"]);
  assert.equal(requests.length, 4);
  assert.equal(elements["garmin-import-status"].textContent, "partial");
  assert.deepEqual(list.children.map(item => item.children[0].children[0].checked), [true, true, false]);
  assert.match(list.children[1].children[0].children[1].children[2].textContent, /download · HTTP 400 · HTTP_ERROR/);
  assert.equal(busy, false);
  assert.equal(elements["garmin-load"].disabled, false);
  assert.equal(list.children[0].children[0].children[1].children[0].textContent, "<script>untrusted</script>");
});

test("Garmin loads older pages, preserves selections and retries the same offset", async t => {
  const elements = Object.fromEntries(["garmin-load", "garmin-load-more", "garmin-activities", "garmin-import-status", "garmin-import-selected", "garmin-import-messages"].map(id => [id, new Element()]));
  elements["garmin-import-messages"].textContent = JSON.stringify({ allLoaded: "all loaded", failed: "failed" });
  const previous = globalThis.document;
  globalThis.document = { getElementById: id => elements[id], createElement: () => new Element() };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const requests = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    assert.equal(elements["garmin-load-more"].disabled, true);
    if (url.includes("?") && fail) {
      fail = false;
      return new Response("{}", { status: 502 });
    }
    const ids = url.includes("?") ? [20, 21] : Array.from({ length: 20 }, (_, i) => i + 1);
    return new Response(JSON.stringify({ data: ids.map(id => ({ id: String(id), name: "Ride", sport: "cycling", duration: 600 })) }));
  });
  initializeGarminImport({ isBusy: () => false, setBusy: () => {}, importFile: async () => ({ status: "imported" }) });
  await elements["garmin-load"].click();
  const list = elements["garmin-activities"];
  const selected = list.children[0].children[0].children[0];
  selected.checked = true;
  assert.equal(elements["garmin-load-more"].hidden, false);
  await elements["garmin-load-more"].click();
  assert.equal(list.children.length, 20);
  assert.equal(selected.checked, true);
  assert.equal(elements["garmin-load-more"].disabled, false);
  await elements["garmin-load-more"].click();
  assert.deepEqual(requests, ["/api/garmin/activities", "/api/garmin/activities?start=20", "/api/garmin/activities?start=20"]);
  assert.equal(list.children.length, 21);
  assert.equal(selected.checked, true);
  assert.equal(elements["garmin-load-more"].hidden, true);
  assert.equal(elements["garmin-import-status"].textContent, "all loaded");
  await elements["garmin-load"].click();
  assert.equal(list.children.length, 20);
  assert.equal(elements["garmin-load-more"].hidden, false);
});
