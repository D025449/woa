import pool from "./database.js";
import {FileDBService} from "./fileDBService.js";


export default class SegmentDBService
{


  static async getBestEffortsBySegment(authSub, segid, page, size, sort, filter) {

    const offset = (page - 1) * size;

    const filter_all = [];
    filter_all.push({ field: 'auth_sub', type: '=', value: authSub });
    filter_all.push({ field: 'segment_id', type: '=', value: segid });
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(sort, filter_all);

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = "WHERE ";//auth_sub = $1";
    let sqlParams = params;
    if (whereSQL) {
      baseWhere += whereSQL.replace("WHERE ", "");
      // sqlParams = [params];
    }

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------

    const dataQuery = `
    SELECT *
    FROM gps_segment_best_efforts
    ${baseWhere}
    ${orderSQL}
    LIMIT $${sqlParams.length + 1}
    OFFSET $${sqlParams.length + 2}
  `;

    const dataParams = [
      ...sqlParams,
      size,
      offset
    ];

    const dataResult = await pool.query(dataQuery, dataParams);

    // -----------------------------------
    // COUNT QUERY
    // -----------------------------------

    const countQuery = `
    SELECT COUNT(*) AS total
    FROM gps_segment_best_efforts
    ${baseWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);

    //const enriched_recs = await FileDBService.post_calculations(authSub, dataResult.rows, "year");

    return {
      data: dataResult.rows,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords
    };
  }


static async querySegmentsByBounds(authSub, bounds, excludeIds, limit)
{



  const result = await pool.query(`
  SELECT
    id,
    auth_sub,
    distance,
    duration,
    start_lat,
    start_lng,
    start_name,
    end_lat,
    end_lng,
    end_name,
    ST_AsGeoJSON(geom)::json AS geom_geojson,
    ST_YMin(bounds) AS min_lat,
    ST_YMax(bounds) AS max_lat,
    ST_XMin(bounds) AS min_lng,
    ST_XMax(bounds) AS max_lng
  FROM gps_segments
  WHERE auth_sub = $1
    AND (
      $2::uuid[] IS NULL
      OR NOT (id = ANY($2))
    )
    AND bounds && ST_MakeEnvelope($3, $4, $5, $6, 4326)

  ORDER BY created_at DESC
  LIMIT $7
`, [
    authSub,
    excludeIds,
    bounds.minLng,
    bounds.minLat,
    bounds.maxLng,
    bounds.maxLat,
    limit

  ]);

  return result;


}




static async insertGpsSegmentsBulk(authSub, segments) {
  if (!segments || segments.length === 0) return [];

  const ids = [];
  const authSubs = [];
  const distances = [];
  const durations = [];

  const startLats = [];
  const startLngs = [];
  const startNames = [];

  const endLats = [];
  const endLngs = [];
  const endNames = [];

  const wkts = []; // 🔥 LINESTRING WKT

  for (const seg of segments) {
    ids.push(seg.id);
    authSubs.push(authSub);

    distances.push(seg.distance);
    durations.push(seg.duration);

    startLats.push(seg.start?.lat ?? null);
    startLngs.push(seg.start?.lng ?? null);
    startNames.push(seg.start?.name ?? null);

    endLats.push(seg.end?.lat ?? null);
    endLngs.push(seg.end?.lng ?? null);
    endNames.push(seg.end?.name ?? null);

    // 🔥 LINESTRING bauen
    const coords = seg.track
      .map(p => `${p.lng} ${p.lat}`) // ⚠️ lng lat!
      .join(", ");

    wkts.push(`LINESTRING(${coords})`);
  }

  const query = `
    INSERT INTO gps_segments (
      id,
      auth_sub,
      distance,
      duration,
      start_lat,
      start_lng,
      start_name,
      end_lat,
      end_lng,
      end_name,
      bounds,
      geom
    )
    SELECT
      u.id,
      u.auth_sub,
      u.distance,
      u.duration,
      u.start_lat,
      u.start_lng,
      u.start_name,
      u.end_lat,
      u.end_lng,
      u.end_name,

      -- bounds automatisch aus geom
      ST_Envelope(ST_GeomFromText(u.wkt, 4326)),

      -- 🔥 LINESTRING
      ST_GeomFromText(u.wkt, 4326)

    FROM UNNEST(
      $1::uuid[],
      $2::text[],
      $3::float8[],
      $4::float8[],
      $5::float8[],
      $6::float8[],
      $7::text[],
      $8::float8[],
      $9::float8[],
      $10::text[],
      $11::text[]
    ) AS u(
      id,
      auth_sub,
      distance,
      duration,
      start_lat,
      start_lng,
      start_name,
      end_lat,
      end_lng,
      end_name,
      wkt
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING *;
  `;

  const values = [
    ids,
    authSubs,
    distances,
    durations,
    startLats,
    startLngs,
    startNames,
    endLats,
    endLngs,
    endNames,
    wkts // 🔥 neu
  ];

  const result = await pool.query(query, values);
  return result.rows;
}


static mapSegment(row, rowstate = 'DB') {
  return {

    id: row.id,
    distance: row.distance,
    duration: row.duration,

    start: {
      lat: row.start_lat,
      lng: row.start_lng,
      name: row.start_name
    },

    end: {
      lat: row.end_lat,
      lng: row.end_lng,
      name: row.end_name
    },

    // 🔥 Track umwandeln
    track: row.geom_geojson.coordinates.map(([lng, lat]) => ({
      lat,
      lng
    })),

    // 🔥 Bounds
    bbox: {
      minLat: row.min_lat,
      maxLat: row.max_lat,
      minLng: row.min_lng,
      maxLng: row.max_lng
    },
    rowstate: rowstate
  };
}

}