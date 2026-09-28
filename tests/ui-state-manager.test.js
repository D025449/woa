import assert from "node:assert/strict";
import test from "node:test";

import UIStateManager from "../src/public/js/UIStateManager.js";

function createStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function withBrowserStorage(callback) {
  const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: createStorage()
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorage()
  });

  try {
    callback();
  } finally {
    if (previousSessionStorage) {
      Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
    } else {
      delete globalThis.sessionStorage;
    }

    if (previousLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
}

test("stores configured UI state persistently and keeps other state in the session", () => {
  withBrowserStorage(() => {
    const state = new UIStateManager("dashboard", {
      persistentKeys: ["splitterWidth"]
    });

    state.set("splitterWidth", 420);
    state.set("selectedWorkoutId", 123);

    assert.deepEqual(
      JSON.parse(globalThis.localStorage.getItem("ui-state:dashboard")),
      { splitterWidth: 420 }
    );
    assert.deepEqual(
      JSON.parse(globalThis.sessionStorage.getItem("ui-state:dashboard")),
      { selectedWorkoutId: 123 }
    );
  });
});

test("migrates configured keys from session storage to local storage", () => {
  withBrowserStorage(() => {
    globalThis.sessionStorage.setItem("ui-state:dashboard", JSON.stringify({
      splitterWidth: 380,
      selectedWorkoutId: 456
    }));

    const state = new UIStateManager("dashboard", {
      persistentKeys: ["splitterWidth"]
    });

    assert.equal(state.get("splitterWidth"), 380);
    assert.deepEqual(
      JSON.parse(globalThis.localStorage.getItem("ui-state:dashboard")),
      { splitterWidth: 380 }
    );
    assert.deepEqual(
      JSON.parse(globalThis.sessionStorage.getItem("ui-state:dashboard")),
      { selectedWorkoutId: 456 }
    );
  });
});

test("prefers an existing persistent value over an older session value", () => {
  withBrowserStorage(() => {
    globalThis.sessionStorage.setItem("ui-state:dashboard", JSON.stringify({
      splitterWidth: 360
    }));
    globalThis.localStorage.setItem("ui-state:dashboard", JSON.stringify({
      splitterWidth: 440
    }));

    const state = new UIStateManager("dashboard", {
      persistentKeys: ["splitterWidth"]
    });

    assert.equal(state.get("splitterWidth"), 440);
    assert.equal(globalThis.sessionStorage.getItem("ui-state:dashboard"), null);
  });
});
