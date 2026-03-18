class RecordGapFiller {
  static fillGaps(records) {
    const maxGap = 5; // Sekunden

    const out = [];

    for (let i = 0; i < records.length - 1; i++) {
      const r0 = records[i];
      const r1 = records[i + 1];

      out.push(r0);

      const t0 = this.toSec(r0.timestamp);
      const t1 = this.toSec(r1.timestamp);

      const gap = t1 - t0;

      if (gap > 1 && gap <= maxGap) {
        const steps = gap - 1;

        for (let s = 1; s <= steps; s++) {
          const ratio = s / gap;

          const interpolated = this.interpolateRecord(r0, r1, ratio, t0 + s);

          out.push(interpolated);
        }
      }
    }

    // letzten Record anhängen
    out.push(records[records.length - 1]);

    return out;
  }

  // ================================
  // RECORD INTERPOLATION
  // ================================
  static interpolateRecord(r0, r1, t, timestampSec) {
    const isStopped =
      (r0.speed === 0 || r0.speed === undefined) &&
      (r1.speed === 0 || r1.speed === undefined);

    return {
      timestamp: new Date(timestampSec * 1000).toISOString(),

      // lineare Felder
      power: this.lerp(r0.power, r1.power, t),
      heart_rate: this.lerp(r0.heart_rate, r1.heart_rate, t),
      cadence: this.lerp(r0.cadence, r1.cadence, t),
      altitude: this.lerp(r0.altitude, r1.altitude, t),
      distance: this.lerp(r0.distance, r1.distance, t),

      // optionale Felder sicher behandeln
      accumulated_power: this.safeLerp(r0.accumulated_power, r1.accumulated_power, t),
      temperature: this.safeLerp(r0.temperature, r1.temperature, t),

      // Zeiten sauber hochzählen
      elapsed_time: r0.elapsed_time + t * (r1.elapsed_time - r0.elapsed_time),
      timer_time: r0.timer_time + t * (r1.timer_time - r0.timer_time),

      // NICHT interpolieren → einfach übernehmen
      left_right_balance: r0.left_right_balance,
      fractional_cadence: r0.fractional_cadence,

      // optional flag
      __interpolated: true
    };
  }

  // ================================
  // HELPERS
  // ================================
  static lerp(a, b, t) {
    if (a == null || b == null) return a ?? b ?? 0;
    return a + (b - a) * t;
  }

  static safeLerp(a, b, t) {
    if (a == null || b == null) return a ?? b ?? null;
    return a + (b - a) * t;
  }

  static toSec(ts) {
    return Math.floor(new Date(ts).getTime() / 1000);
  }
}

export { RecordGapFiller };