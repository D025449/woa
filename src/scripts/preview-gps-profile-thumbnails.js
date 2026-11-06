import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { load } from "cheerio";
import dotenv from "dotenv";
import { applyRuntimeDatabasePointer } from "../../ops/postgres-backup/runtime-database.mjs";

export function buildBandProfileThumbnail(metricSvg, altitudeSvg) {
  const metric = load(metricSvg, { xml: true });
  const altitude = load(altitudeSvg, { xml: true });
  const powerPath = metric('path[stroke="#2563eb"]').attr("d");
  const altitudePath = altitude('path[stroke="none"]').attr("d");
  if (!powerPath || !altitudePath) throw new Error("Power and altitude profiles required");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 256 160">
    <rect width="256" height="160" fill="#ffffff"/>
    <g data-band="power"><text data-band-label="power" x="18" y="10" font-family="sans-serif" font-size="8" fill="#2563eb">Power</text>
      <svg y="10" width="256" height="66" viewBox="0 0 256 160" preserveAspectRatio="none"><path d="${powerPath} L 238 134 L 18 134 Z" fill="#2563eb" fill-opacity="0.26" stroke="none"/></svg></g>
    <path d="M 18 80 H 238" stroke="#dce3e8" stroke-width="0.5"/>
    <g data-band="altitude"><text data-band-label="altitude" x="18" y="91" font-family="sans-serif" font-size="8" fill="#0891b2">Altitude</text>
      <svg y="92" width="256" height="66" viewBox="0 0 256 160" preserveAspectRatio="none"><g transform="translate(18 0) scale(${220 / 228} 1) translate(-14 0)"><path d="${altitudePath}" fill="#38bdf8" fill-opacity="0.3" stroke="none"/></g></svg></g>
    </svg>`;
}

export function buildGpsProfileComparison(routeSvg, metricSvg, { bands = false } = {}) {
  const metric = load(metricSvg, { xml: true });
  const curves = metric("path").filter((_, element) =>
    ["#2563eb", "#16a34a", "#f59e0b"].includes(metric(element).attr("stroke")));
  if (!bands && !curves.length) throw new Error("Metric curves required");
  let profileMarkup;
  if (bands) {
    metric("[data-band-label], svg > rect").remove();
    profileMarkup = metric("svg").first().html();
  } else {
    curves.attr("vector-effect", "non-scaling-stroke").attr("stroke-width", "1");
    profileMarkup = curves.toArray().map(element => metric.xml(element)).join("");
  }
  const route = load(routeSvg, { xml: true });
  const background = route('image[data-map-provider="local"]');
  if (background.length !== 1) throw new Error("Local map background required");
  const strip = `<g data-preview-profile="${bands ? "bands" : "metrics"}"><rect x="4" y="128" width="312" height="48" rx="4" fill="#ffffff" fill-opacity="${bands ? "0.6" : "0.88"}"/>
    <svg x="4" y="128" width="312" height="48" viewBox="0 0 256 160" preserveAspectRatio="none">${profileMarkup}</svg></g>`;
  background.after(strip);
  return route.xml();
}

export function buildComparisonPage(examples, { bands = false, production = false, nonGpsExamples = [] } = {}) {
  const image = (svg, className) => `<img class="${className}" width="320" height="200" alt="" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`;
  const column = (label, svg) => `<figure><figcaption>${label}</figcaption>${image(svg, "native")}${image(svg, "list-size")}</figure>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Thumbnail-Vergleich</title><style>
    *{box-sizing:border-box}body{margin:0;color:#253128;font-family:"Trebuchet MS",sans-serif;background:#f7f9f8;background-image:linear-gradient(#e7ece955 1px,transparent 1px);background-size:100% 32px}
    main{max-width:1100px;margin:auto;padding:28px 24px}header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-bottom:2px solid #426950;padding-bottom:16px}
    h1{font-family:Georgia,serif;font-size:26px;font-weight:400;margin:0}header span{font-size:13px;color:#647067}section{padding:24px 0;border-bottom:1px solid #dce3dd}h2{font-size:15px;font-weight:600;margin:0 0 18px}
    .comparison{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}figure{margin:0;min-width:0}figcaption{font-size:13px;margin-bottom:10px;color:#536158}
    nav{display:flex;gap:20px;margin-top:18px}nav a{color:#536158;text-decoration:none;padding-bottom:8px;border-bottom:2px solid transparent}nav a[aria-current="page"]{color:#253128;border-color:#426950}
    img{display:block;object-fit:contain;max-width:100%;height:auto}.native{width:320px;aspect-ratio:16/10}.list-size{width:152px;aspect-ratio:16/10;margin-top:16px}
    @media(max-width:760px){main{padding:20px 16px}header{flex-wrap:wrap}.comparison{grid-template-columns:1fr;gap:24px}figure{display:grid;grid-template-columns:minmax(0,320px);justify-content:center}h1{font-size:24px}}
    </style></head><body><main><header><h1>Thumbnail-Vergleich</h1><span>Dev &middot; 320 &times; 200 / 152 &times; 95</span></header>
    <nav><a href="index.html" ${!bands && !production ? 'aria-current="page"' : ""}>Linien</a><a href="bands.html" ${bands && !production ? 'aria-current="page"' : ""}>B&auml;nder</a><a href="production.html" ${production ? 'aria-current="page"' : ""}>GPS / Ohne GPS</a></nav>
    ${examples.map(example => `<section><h2>Workout ${Number(example.id)}</h2><div class="comparison">${column("Karte", example.route)}${column(bands ? "Karte + B&auml;nder" : "Karte + Profil", example.combined)}${column(production ? "GPS-Profil" : bands ? "Power / Altitude" : "Profil", example.metric)}</div></section>`).join("")}
    ${nonGpsExamples.map(example => `<section><h2>Workout ${Number(example.id)} &middot; Ohne GPS</h2>${column("Profil", example.metric)}</section>`).join("")}
    </main></body></html>`;
}

export async function createGpsProfilePreview(argv) {
  const { values } = parseArgs({ args: argv, options: { "env-file": { type: "string" } } });
  const envFile = values["env-file"];
  if (!envFile || path.basename(envFile) !== ".env.development") throw new Error("Explicit development environment required");
  const loaded = dotenv.config({ path: path.resolve(envFile), override: true, quiet: true });
  if (loaded.error || !loaded.parsed?.DB_NAME || !loaded.parsed.DB_USER
    || loaded.parsed.NODE_ENV && loaded.parsed.NODE_ENV !== "development"
    || !["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || "localhost")) throw new Error("Local development database required");
  process.env.NODE_ENV = "development";
  applyRuntimeDatabasePointer(process.env);
  const [{ default: pool }, { default: Workout }, { default: ThumbnailService }, { default: GpsTrackBlobService }] = await Promise.all([
    import("../services/database.js"), import("../shared/Workout.js"), import("../services/workoutThumbnailService.js"),
    import("../services/gpsTrackBlobService.js")
  ]);
  const examples = [];
  const bandExamples = [];
  const productionExamples = [];
  const nonGpsExamples = [];
  try {
    const connection = await pool.connect();
    let rows;
    let nonGpsRows;
    try {
      await connection.query("BEGIN READ ONLY");
      const identity = await connection.query("SELECT current_database() AS name");
      if (identity.rows[0]?.name !== process.env.DB_NAME) throw new Error("Unexpected development database");
      const result = await connection.query(`SELECT w.id, w.stream, w.stream_codec, w.gps_track_blob, w.gps_track_blob_codec, wt.content
        FROM workouts w JOIN workout_thumbnails wt ON wt.workout_id=w.id
        WHERE w.validgps=true AND w.stream IS NOT NULL AND wt.kind='route'
          AND wt.content LIKE '%data-map-provider="local"%'
        ORDER BY w.id DESC LIMIT 12`);
      rows = result.rows;
      const nonGpsResult = await connection.query(`SELECT id, stream, stream_codec, workout_type
        FROM workouts WHERE validgps IS NOT TRUE AND stream IS NOT NULL ORDER BY id DESC LIMIT 6`);
      nonGpsRows = nonGpsResult.rows;
      await connection.query("COMMIT");
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
    for (const row of rows) {
      const stream = await Workout.decompress(row.stream, row.stream_codec || "brotli");
      const series = Workout.getWst9ThumbnailSeries(stream, { includeProfiles: true });
      const metric = ThumbnailService.createThumbnailPayload({
        profileStyle: "lines",
        powers: Array.from(series.powers), heartRates: Array.from(series.heartRates), cadences: Array.from(series.cadences)
      });
      if (!metric?.content) continue;
      examples.push({ id: row.id, route: row.content, metric: metric.content,
        combined: buildGpsProfileComparison(row.content, metric.content) });
      const profileSeries = { powers: series.powers, heartRates: series.heartRates, altitudes: series.altitudes, speeds: series.speeds, gps: true };
      const productionMetric = ThumbnailService.createBandProfileThumbnail(profileSeries);
      const decodedGps = await GpsTrackBlobService.decodeCompressed(row.gps_track_blob, { codec: row.gps_track_blob_codec || "identity" });
      const combined = await ThumbnailService.createThumbnailPayloadAsync({ ...profileSeries, gpsTrack: decodedGps.track }, {
        renderRoute: async () => ({ kind: "route", mimeType: "image/svg+xml", width: 320, height: 200, content: row.content })
      });
      if (productionMetric && combined?.kind === "route") productionExamples.push({ id: row.id, route: row.content, metric: productionMetric.content,
        combined: combined.content });
      const workout = Workout.fromBuffer(stream);
      const altitudes = Array.from({ length: workout.length }, (_, index) => workout.getAltitudeAt(index));
      const finiteAltitudes = altitudes.filter(Number.isFinite);
      if (finiteAltitudes.length >= 2 && series.powers.some(value => value > 0)) {
        const minimum = Math.min(...finiteAltitudes);
        const maximum = Math.max(...finiteAltitudes);
        const padding = Math.max(10, (maximum - minimum) * 0.05);
        const baseline = Math.floor((minimum - padding) / 10) * 10;
        const altitude = ThumbnailService.createThumbnailPayload({ profileStyle: "lines", altitudes: finiteAltitudes.map(value => value - baseline), powers: [] });
        if (altitude?.content) {
          const bands = buildBandProfileThumbnail(metric.content, altitude.content);
          bandExamples.push({ id: row.id, route: row.content, metric: bands,
            combined: buildGpsProfileComparison(row.content, bands, { bands: true }) });
        }
      }
      if (examples.length === 3) break;
    }
    for (const row of nonGpsRows) {
      const stream = await Workout.decompress(row.stream, row.stream_codec || "brotli");
      const series = Workout.getWst9ThumbnailSeries(stream, { includeProfiles: true });
      const metric = ThumbnailService.createThumbnailPayload({ workoutType: row.workout_type,
        powers: Array.from(series.powers), heartRates: Array.from(series.heartRates),
        altitudes: Array.from(series.altitudes), speeds: Array.from(series.speeds) });
      if (metric) nonGpsExamples.push({ id: row.id, metric: metric.content });
      if (nonGpsExamples.length === 3) break;
    }
    if (!examples.length) throw new Error("No local map workouts with metric profiles");
    const directory = path.resolve("tmp/gps-profile-preview");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "index.html");
    await writeFile(filename, buildComparisonPage(examples), { mode: 0o600 });
    const bandsFilename = path.join(directory, "bands.html");
    if (!bandExamples.length) throw new Error("No power and altitude examples");
    await writeFile(bandsFilename, buildComparisonPage(bandExamples, { bands: true }), { mode: 0o600 });
    const productionFilename = path.join(directory, "production.html");
    await writeFile(productionFilename, buildComparisonPage(productionExamples, { bands: true, production: true, nonGpsExamples }), { mode: 0o600 });
    console.log(JSON.stringify({ preview: filename, bandsPreview: bandsFilename,
      productionPreview: productionFilename, nonGpsWorkouts: nonGpsExamples.map(example => example.id),
      workouts: examples.map(example => example.id), bandWorkouts: bandExamples.map(example => example.id) }));
    return filename;
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createGpsProfilePreview(process.argv.slice(2)).catch(() => {
    console.error("GPS profile preview failed; check local Dev data. Existing thumbnails were not changed.");
    process.exitCode = 1;
  });
}