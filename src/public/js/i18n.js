function resolvePath(source, key) {
  return String(key)
    .split(".")
    .reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), source);
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return String(params[token]);
    }

    return match;
  });
}

export function createTranslator(namespace = "") {
  const root = globalThis.__I18N?.messages || {};
  const scoped = namespace ? resolvePath(root, namespace) : root;

  return (key, params = {}) => {
    const value = resolvePath(scoped || {}, key);
    if (typeof value !== "string") {
      return namespace ? `${namespace}.${key}` : key;
    }

    return interpolate(value, params);
  };
}

export function getCurrentLocale() {
  return globalThis.__I18N?.locale || "en";
}
