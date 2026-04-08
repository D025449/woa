import pool from "./database.js";
import pkg from "pg-copy-streams";
const { from: copyFrom } = pkg;

export default class FilesStreamsApi {

  static async insertStreams(
    wid,
    uid,
    powers,
    heartRates,
    cadences,
    speeds,
    altitudes
  ) {

    const length = powers?.length ?? 0;

    if (
      length === 0 ||
      !(
        length === heartRates.length &&
        length === cadences.length &&
        length === speeds.length &&
        length === altitudes.length
      )
    ) {
      throw new Error("Invalid or empty input arrays");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const stream = client.query(copyFrom(`
        COPY workout_streams (
          wid,
          idx,
          power,
          hr,
          cadence,
          speed,
          altitude,
          cum_power,
          cum_hr,
          cum_cadence,
          cum_speed,
          cum_elevation_gain
        )
        FROM STDIN WITH (FORMAT csv)
      `));

      let cumPower = 0;
      let cumHr = 0;
      let cumCadence = 0;
      let cumSpeed = 0;
      let cumElevationGain = 0;

      for (let i = 0; i < length; i++) {

        const power = powers[i] ?? "";
        const hr = heartRates[i] ?? "";
        const cadence = cadences[i] ?? "";

        const speed = speeds[i] != null
          ? Math.round(speeds[i] * 10)
          : "";

        const altitude = altitudes[i] ?? "";

        if (power !== "") cumPower += power;
        if (hr !== "") cumHr += hr;
        if (cadence !== "") cumCadence += cadence;
        if (speed !== "") cumSpeed += speed;

        if (i > 0 && altitude !== "" && altitudes[i - 1] != null) {
          const diff = altitude - altitudes[i - 1];
          if (diff > 0) cumElevationGain += diff;
        }

        const row = [
          wid,
          i,
          power,
          hr,
          cadence,
          speed,
          altitude,
          cumPower,
          cumHr,
          cumCadence,
          cumSpeed,
          cumElevationGain
        ].join(",");

        stream.write(row + "\n");
      }

      stream.end();

      await new Promise((resolve, reject) => {
        stream.on("finish", resolve);
        stream.on("error", reject);
      });

      await client.query("COMMIT");

    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}