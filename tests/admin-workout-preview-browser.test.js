import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ejs from "ejs";
import { load } from "cheerio";
import { initAdminFacets } from "../src/public/js/admin-facets.js";

const browserSource = await fs.readFile(
  new URL("../src/public/js/admin-accounts.js", import.meta.url),
  "utf8"
);
const routeSource = await fs.readFile(
  new URL("../src/routes/adminAccountBackupRoutes.js", import.meta.url),
  "utf8"
);

test("admin facets preserve mounted panels and support direct links, selection and history", () => {
  const handlers = new Map();
  const bind = (target, type, listener) => handlers.set(`${target}:${type}`, listener);
  const view = { location: { hash: "" }, history: { pushState(_state, _title, hash) { view.location.hash = hash; } },
    addEventListener(type, listener) { bind("window", type, listener); } };
  const panels = ["users", "maps", "database", "system-backup", "accounts", "segments", "workouts"].map(id => ({
    id, hidden: false, value: "unsaved", contains(target) { return target?.parent === this; }
  }));
  const links = panels.map(panel => ({ hash: `#${panel.id}`, current: false,
    setAttribute() { this.current = true; }, removeAttribute() { this.current = false; },
    addEventListener(type, listener) { bind(panel.id, type, listener); } }));
  const select = { value: "", addEventListener(type, listener) { bind("select", type, listener); } };
  const anchor = { parent: panels[1], scrolled: false, scrollIntoView() { this.scrolled = true; } };
  const root = { dataset: {}, ownerDocument: { defaultView: view,
    getElementById(id) { return id === "local-map-management" ? anchor : panels.find(panel => panel.id === id); } },
  querySelectorAll(selector) { return selector === "[data-admin-panel]" ? panels : links; },
  querySelector() { return select; } };
  initAdminFacets(root);
  const active = () => panels.filter(panel => !panel.hidden).map(panel => panel.id);
  assert.deepEqual(active(), ["users"]);
  assert.equal(root.dataset.facetsReady, "true");
  handlers.get("maps:click")({ button: 0, preventDefault() {} });
  assert.deepEqual(active(), ["maps"]);
  assert.equal(view.location.hash, "#maps");
  assert.equal(links[1].current, true);
  assert.equal(select.value, "maps");
  select.value = "workouts";
  handlers.get("select:change")();
  assert.deepEqual(active(), ["workouts"]);
  view.location.hash = "#local-map-management";
  handlers.get("window:popstate")();
  assert.deepEqual(active(), ["maps"]);
  assert.equal(anchor.scrolled, true);
  for (const hash of ["#missing", "#%E0%A4%A"]) {
    view.location.hash = hash;
    handlers.get("window:hashchange")();
    assert.deepEqual(active(), ["users"]);
  }
  handlers.get("maps:click")({ button: 0, ctrlKey: true, preventDefault() { assert.fail("modified clicks stay native"); } });
  assert.deepEqual(active(), ["users"]);
  assert.ok(panels.every(panel => panel.value === "unsaved"));
});

test("admin template preserves unique controls inside seven nonnested facets", async () => {
  const source = await fs.readFile(new URL("../src/views/admin-accounts.ejs", import.meta.url), "utf8");
  const $ = load(ejs.render(source, { userInfo: {}, include: () => "" }));
  const ids = $("[id]").map((_index, node) => $(node).attr("id")).get();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal($("[data-admin-panel]").length, 7);
  assert.equal($("[data-admin-panel] [data-admin-panel]").length, 0);
  for (const [facet, control] of Object.entries({ users: "admin-user-roles", maps: "local-map-management",
    database: "database-backup-wizard", "system-backup": "logical-backup-wizard",
    accounts: "account-backup-import-form", segments: "segment-backup-import-form", workouts: "workout-backup-import-form" })) {
    assert.equal($(`[data-admin-link][href="#${facet}"]`).length, 1);
    assert.equal($(`[data-admin-select] option[value="${facet}"]`).length, 1);
    assert.equal($(`#${control}`).closest("[data-admin-panel]").attr("id"), facet);
  }
  assert.equal($("[data-admin-panel][hidden]").length, 0);
  assert.equal($("h1").text(), "Administration");
});

test("workout preview sends compact JSON metadata instead of the ZIP archive", () => {
  assert.match(browserSource, /buildLocalWorkoutPreview\(archive\)/u);
  assert.match(browserSource, /body: JSON\.stringify\(metadata\)/u);
  assert.match(browserSource, /application\/vnd\.cwa24\.workout-preview\+json/u);
  assert.doesNotMatch(
    browserSource,
    /sendWorkoutArchive\("\/admin\/accounts\/workouts\/preview/u
  );
});

test("workout preview route accepts bounded raw metadata rather than multer", () => {
  assert.match(
    routeSource,
    /express\.raw\(\{ type: "application\/vnd\.cwa24\.workout-preview\+json", limit: "5mb" \}\)/u
  );
  assert.doesNotMatch(
    routeSource,
    /router\.post\("\/workouts\/preview", workoutUpload/u
  );
});
