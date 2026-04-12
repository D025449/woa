export default class UIStateManager {
  constructor(namespace = "app") {
    this.key = `ui-state:${namespace}`;
    this.state = this.load();
  }

  // -------------------------
  // Load / Save
  // -------------------------
  load() {
    try {
      const raw = sessionStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  save() {
    sessionStorage.setItem(this.key, JSON.stringify(this.state));
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