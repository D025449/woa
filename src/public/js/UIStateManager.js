export default class UIStateManager {
  constructor(namespace = "app", { persistentKeys = [] } = {}) {
    this.key = `ui-state:${namespace}`;
    this.persistentKeys = new Set(persistentKeys);
    this.state = this.load();
    this.save();
  }

  // -------------------------
  // Load / Save
  // -------------------------
  load() {
    const sessionState = this.readStorage(this.getStorage("sessionStorage"));
    const persistentState = this.readStorage(this.getStorage("localStorage"));

    for (const key of this.persistentKeys) {
      if (Object.hasOwn(persistentState, key)) {
        sessionState[key] = persistentState[key];
      }
    }

    return sessionState;
  }

  save() {
    const sessionState = {};
    const persistentState = {};

    for (const [key, value] of Object.entries(this.state)) {
      if (this.persistentKeys.has(key)) {
        persistentState[key] = value;
      } else {
        sessionState[key] = value;
      }
    }

    this.writeStorage(this.getStorage("sessionStorage"), sessionState);
    this.writeStorage(this.getStorage("localStorage"), persistentState);
  }

  getStorage(name) {
    try {
      return globalThis[name];
    } catch {
      return null;
    }
  }

  readStorage(storage) {
    try {
      const raw = storage?.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  writeStorage(storage, value) {
    try {
      if (Object.keys(value).length === 0) {
        storage?.removeItem(this.key);
        return;
      }

      storage?.setItem(this.key, JSON.stringify(value));
    } catch {
      // Browser storage can be unavailable or full. UI state is optional.
    }
  }

  // -------------------------
  // Generic Getter / Setter
  // -------------------------
  set(key, value) {
    this.state[key] = value;
    this.save();
  }

  get(key, defaultValue = null) {
    return this.state[key] ?? defaultValue;
  }

  remove(key) {
    delete this.state[key];
    this.save();
  }

  clear() {
    this.state = {};
    this.save();
  }
}
