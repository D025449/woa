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

  if (Array.isArray(input)) {
    return input.map((value) => normalizeFitPayload(value));
  }

  if (input && typeof input === "object") {
    return normalizeObjectEntries(input);
  }

  return input;
}
