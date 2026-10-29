// Analytics dates use the UTC calendar date of the source workout/estimate.
export function powerWeightDate(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function powerWeightFields(power, weightKg, weightSource, date) {
  const weight = Number(weightKg);
  const valid = weightKg != null && Number.isFinite(weight) && weight > 0 && weight <= 500;
  return {
    weightKg: valid ? weight : null,
    weightSource: valid ? weightSource ?? null : null,
    weightDate: powerWeightDate(date),
    wattsPerKg: valid && power != null && Number.isFinite(Number(power)) ? Number(power) / weight : null
  };
}
