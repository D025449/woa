function normalizeObjectEntries(input) {
  return Object.keys(input)
    .sort((left, right) => left.localeCompare(right))
    .reduce((result, key) => {
      const value = input[key];
      if (value === undefined) {
        return result;
      }
      result[key] = normalizeFitPayload(value);
      return result;
    }, {});
}

export function normalizeFitPayload(input) {
  if (input instanceof Date) {
    return input.toISOString();
  }

  if (typeof input === "string") {
    let terminatorIndex = -1;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) {
        terminatorIndex = index;
        break;
      }
    }
    return terminatorIndex >= 0 ? input.slice(0, terminatorIndex) : input;
  }

  if (Array.isArray(input)) {
    return input.map((value) => normalizeFitPayload(value));
  }

  if (input && typeof input === "object") {
    return normalizeObjectEntries(input);
  }

  return input;
}
