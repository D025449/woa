import pool from "./database.js";
import GpsTrackBlobService from "./gpsTrackBlobService.js";
import { FileDBService } from "./fileDBService.js";
import SegmentMatcher from "./SegmentMatcher.js";
import WorkoutDBService from "./workoutDBService.js";
import CollaborationDBService from "./collaborationDBService.js";
import WorkoutSharingService from "./workoutSharingService.js";
import SegmentTrackBlobService from "./segmentTrackBlobService.js";
import { parsePostgresBox, toPostgresBox } from "../shared/postgresSpatial.js";
import { matchGpsSegmentBestEfforts } from "../shared/BrowserGpsSegmentMatcher.js";
import {
  matchCompactGpsSegmentBestEfforts,
  prepareCompactGpsSegmentDefinitions
} from "../shared/CompactGpsSegmentMatcher.js";


const SEGMENT_BEST_EFFORTS_COMPACT_MATCHER = String(
  process.env.SEGMENT_BEST_EFFORTS_COMPACT_MATCHER || "1"
).trim() !== "0";
const SEGMENT_BEST_EFFORTS_DIRECT_AVERAGES = String(
  process.env.SEGMENT_BEST_EFFORTS_DIRECT_AVERAGES || "1"
).trim() !== "0";

export default class SegmentDBService {

  static async hydrateSegmentTrackRow(row) {
    if (!row) return row;
    const decoded = await SegmentTrackBlobService.decodeRow(row);
    const bbox = parsePostgresBox(row.gps_bounds_text ?? row.gps_bounds) ?? decoded.bbox;
    const coordinates = decoded.points.map((point) => [point.lng, point.lat]);
    return {
      ...row,
      geom: { type: "LineString", coordinates },
      geom_geojson: { type: "LineString", coordinates },
      min_lat: bbox?.minLat ?? null,
      max_lat: bbox?.maxLat ?? null,
      min_lng: bbox?.minLng ?? null,
      max_lng: bbox?.maxLng ?? null
    };
  }

  static async getSegmentDistanceMap(segmentIds = []) {
    const normalizedIds = [...new Set(
      (Array.isArray(segmentIds) ? segmentIds : [])
        .map((segmentId) => Number(segmentId))
        .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0)
    )];

    if (!normalizedIds.length) {
      return new Map();
    }

    const result = await pool.query(`
      SELECT id, distance
      FROM gps_segments
      WHERE id = ANY($1::bigint[])
    `, [normalizedIds]);

    return new Map(
      result.rows.map((row) => [Number(row.id), Number(row.distance) || 0])
    );
  }

  static calculateNormalizedSegmentSpeed(distanceMeters, durationSeconds) {
    const distance = Number(distanceMeters);
    const duration = Number(durationSeconds);

    if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    return Math.round(((distance * 3.6) / duration) * 10) / 10;
  }

  static allowedColumns = [
    "id",
    "sid",
    "wid",
    "start_time",
    "uid",
    "duration",
    "start_offset",
    "end_offset",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed",
  ];

  static numericFields = [
    "duration",
    "start_time",
    "start_offset",
    "end_offset",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed"
  ];

  static async storeSegmentBestEffortsV2(matches) {
    const distanceMap = await SegmentDBService.getSegmentDistanceMap(matches.map((match) => match.segment_id));

    const gps_segments_be = [];
    matches.forEach(match => {
      const duration = match.end_offset - match.start_offset;
      const segment_id = match.segment_id;
      const file_id = match.workout_id;
      const start_offset = match.start_offset;
      const end_offset = match.end_offset;
      const avg_power = match.power;
      const avg_heart_rate = match.hr;
      const avg_cadence = match.cadence;
      const avg_speed = SegmentDBService.calculateNormalizedSegmentSpeed(
        distanceMap.get(Number(segment_id)),
        duration
      );

      gps_segments_be.push({
        segment_id,
        file_id,
        start_offset,
        end_offset,
        duration,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      });

    });

    const segmentIds = [];
    const fileIds = [];
    const starts = [];
    const ends = [];
    const durations = [];
    const pws = [];
    const hrs = [];
    const cds = [];
    const sps = [];

    for (const m of gps_segments_be) {
      segmentIds.push(m.segment_id);
      fileIds.push(m.file_id);
      starts.push(m.start_offset);
      ends.push(m.end_offset);
      durations.push(m.duration);
      pws.push(m.avg_power);
      hrs.push(m.avg_heart_rate);
      cds.push(m.avg_cadence);
      sps.push(m.avg_speed);
    }

    const result = await pool.query(`
    INSERT INTO gps_segment_best_efforts (
      sid,
      wid,
      start_offset,
      end_offset,
      duration,
      avg_power,
      avg_heart_rate,
      avg_cadence,
      avg_speed
    )
    SELECT *
    FROM UNNEST(
      $1::int[],
      $2::int[],   
      $3::int[],   
      $4::int[],   
      $5::int[],    
      $6::float8[],
      $7::float8[],
      $8::float8[],
      $9::float8[]
    )
    RETURNING *;
  `, [segmentIds, fileIds, starts, ends, durations, pws, hrs, cds, sps]);

    return result.rows;

  }


  static matchSegments(workout, segments) {
    const results = [];

    const normalizedWorkoutSegments = Array.isArray(workout?.trackSegments) && workout.trackSegments.length
      ? workout.trackSegments
          .map((segment) => (Array.isArray(segment) ? segment : [])
            .map((point, index) => ({
              lat: Number(point?.lat),
              lng: Number(point?.lng),
              slotIndex: Number.isFinite(Number(point?.slotIndex)) ? Number(point.slotIndex) : index
            }))
            .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)))
          .filter((segment) => segment.length >= 2)
      : (Array.isArray(workout?.track)
          ? [workout.track
              .map((point, index) => {
                if (Array.isArray(point)) {
                  return {
                    lat: Number(point[0]),
                    lng: Number(point[1]),
                    slotIndex: index
                  };
                }

                return {
                  lat: Number(point?.lat),
                  lng: Number(point?.lng),
                  slotIndex: Number.isFinite(Number(point?.slotIndex)) ? Number(point.slotIndex) : index
                };
              })
              .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))]
          : [])
          .filter((segment) => segment.length >= 2);

    if (!normalizedWorkoutSegments.length) {
      return results;
    }

    const wotrack = {
      wid: workout.id,
      track: normalizedWorkoutSegments[0],
      segments: normalizedWorkoutSegments,
      sampleRate: workout.sampleRate
    }


    for (const seg of segments) {
      //results.push( ... matchSegment(track, seg));
      const segLine = seg.geom.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const m = SegmentMatcher.findMatches(wotrack, { id: seg.id, track: segLine });
      //console.log({ wid: workout.id, sid: seg.id, segcount: m.length });
      results.push(...m);
    }

    return results;
  }


  static async storeSegmentBestEfforts(matches, workoutObject) {
    const distanceMap = await SegmentDBService.getSegmentDistanceMap(matches.map((match) => match.segment_id));

    const gps_segments_be = [];
    matches.forEach(match => {
      const duration = match.end_offset - match.start_offset;
      const segment_id = match.segment_id;
      const file_id = match.workout_id;
      const start_offset = match.start_offset;
      const end_offset = match.end_offset;
      const averages = workoutObject.getAverages(start_offset, end_offset);
      const avg_power = Math.round(averages.power ?? 0);
      const avg_heart_rate = Math.round(averages.hr ?? 0);
      const avg_cadence = Math.round(averages.cadence ?? 0);
      const avg_speed = SegmentDBService.calculateNormalizedSegmentSpeed(
        distanceMap.get(Number(segment_id)),
        duration
      );

      gps_segments_be.push({
        segment_id,
        file_id,
        start_offset,
        end_offset,
        duration,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      });

    });

    const segmentIds = [];
    const fileIds = [];
    const starts = [];
    const ends = [];
    const durations = [];
    const pws = [];
    const hrs = [];
    const cds = [];
    const sps = [];

    for (const m of gps_segments_be) {
      segmentIds.push(m.segment_id);
      fileIds.push(m.file_id);
      starts.push(m.start_offset);
      ends.push(m.end_offset);
      durations.push(m.duration);
      pws.push(m.avg_power);
      hrs.push(m.avg_heart_rate);
      cds.push(m.avg_cadence);
      sps.push(m.avg_speed);
    }

    const result = await pool.query(`
    INSERT INTO gps_segment_best_efforts (
      sid,
      wid,
      start_offset,
      end_offset,
      duration,
      avg_power,
      avg_heart_rate,
      avg_cadence,
      avg_speed
    )
    SELECT *
    FROM UNNEST(
      $1::int[],
      $2::int[],   
      $3::int[],   
      $4::int[],   
      $5::int[],    
      $6::float8[],
      $7::float8[],
      $8::float8[],
      $9::float8[]
    )
    RETURNING *;
  `, [segmentIds, fileIds, starts, ends, durations, pws, hrs, cds, sps]);

    return result.rows;

  }

  static async storeSegmentBestEffortsForWorkoutsBulk(matches, workoutObjectsById, segmentDefinitionsById) {
    const segmentIds = [];
    const fileIds = [];
    const starts = [];
    const ends = [];
    const durations = [];
    const powers = [];
    const heartRates = [];
    const cadences = [];
    const speeds = [];

    for (const match of Array.isArray(matches) ? matches : []) {
      const workoutId = Number(match?.workout_id);
      const segmentId = Number(match?.segment_id);
      const workoutObject = workoutObjectsById.get(workoutId);
      const segmentDefinition = segmentDefinitionsById.get(segmentId);
      if (!workoutObject || !segmentDefinition) {
        continue;
      }

      const startOffset = Number(match.start_offset);
      const endOffset = Number(match.end_offset);
      const duration = endOffset - startOffset;
      if (!Number.isFinite(duration) || duration <= 0) {
        continue;
      }
      const averages = workoutObject.getAverages(startOffset, endOffset);
      segmentIds.push(segmentId);
      fileIds.push(workoutId);
      starts.push(startOffset);
      ends.push(endOffset);
      durations.push(duration);
      powers.push(Math.round(averages.power ?? 0));
      heartRates.push(Math.round(averages.hr ?? 0));
      cadences.push(Math.round(averages.cadence ?? 0));
      speeds.push(this.calculateNormalizedSegmentSpeed(segmentDefinition.distance, duration));
    }

    if (segmentIds.length === 0) {
      return { insertedCount: 0 };
    }

    await pool.query(`
      INSERT INTO gps_segment_best_efforts (
        sid,
        wid,
        start_offset,
        end_offset,
        duration,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      )
      SELECT *
      FROM UNNEST(
        $1::int[],
        $2::int[],
        $3::int[],
        $4::int[],
        $5::int[],
        $6::float8[],
        $7::float8[],
        $8::float8[],
        $9::float8[]
      )
    `, [segmentIds, fileIds, starts, ends, durations, powers, heartRates, cadences, speeds]);

    return { insertedCount: segmentIds.length };
  }

  static async getMatchingSegmentCandidatesV2(bounds, uid, workoutId = null, options = {}) {
    const includeExistingBestEfforts = options?.includeExistingBestEfforts === true;
    const sql = `SELECT
      s.id,
      s.track_blob,
      s.track_blob_codec,
      s.gps_bounds::text AS gps_bounds_text
      FROM gps_segments s
      WHERE
        (
          s.uid = $1
          OR (
            $3::bigint IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM gps_segment_group_shares sgs
              INNER JOIN workout_group_shares wgs
                ON wgs.group_id = sgs.group_id
              WHERE sgs.segment_id = s.id
                AND wgs.workout_id = $3
            )
          )
        )
        AND s.gps_bounds && $2::box
        AND (
          $3::bigint IS NULL
          OR $4::boolean = true
          OR NOT EXISTS (
            SELECT 1
            FROM gps_segment_best_efforts sbe
            WHERE sbe.wid = $3
              AND sbe.sid = s.id
          )
        );`;

    const result = await pool.query(
      sql,
      [uid,
      toPostgresBox(bounds),
      workoutId,
      includeExistingBestEfforts]
    );

    return Promise.all(result.rows.map((row) => SegmentDBService.hydrateSegmentTrackRow(row)));
  }

  static async getMatchingSegmentCandidateIdsForWorkoutsBulk(uid, workoutIds, options = {}) {
    const includeExistingBestEfforts = options?.includeExistingBestEfforts === true;
    const normalizedIds = [...new Set((Array.isArray(workoutIds) ? workoutIds : [])
      .map(Number)
      .filter(Number.isInteger))];
    const candidatesByWorkoutId = new Map(normalizedIds.map((workoutId) => [workoutId, []]));
    if (normalizedIds.length === 0) {
      return { candidatesByWorkoutId, segmentIds: [] };
    }

    const result = await pool.query(`
      WITH source_workouts AS (
        SELECT id, uid, gps_bounds
        FROM workouts
        WHERE uid = $1
          AND id = ANY($2::bigint[])
          AND validgps = true
          AND gps_bounds IS NOT NULL
      )
      SELECT
        w.id AS workout_id,
        s.id AS segment_id
      FROM source_workouts w
      JOIN gps_segments s
        ON s.gps_bounds && w.gps_bounds
        AND (
          s.uid = $1
          OR EXISTS (
            SELECT 1
            FROM gps_segment_group_shares sgs
            INNER JOIN workout_group_shares wgs
              ON wgs.group_id = sgs.group_id
            WHERE sgs.segment_id = s.id
              AND wgs.workout_id = w.id
          )
        )
      WHERE $3::boolean = true
        OR NOT EXISTS (
          SELECT 1
          FROM gps_segment_best_efforts sbe
          WHERE sbe.wid = w.id
            AND sbe.sid = s.id
        )
      ORDER BY w.id, s.id
    `, [uid, normalizedIds, includeExistingBestEfforts]);

    const segmentIds = new Set();
    for (const row of result.rows) {
      const workoutId = Number(row.workout_id);
      const segmentId = Number(row.segment_id);
      const candidates = candidatesByWorkoutId.get(workoutId);
      if (candidates && Number.isInteger(segmentId)) {
        candidates.push(segmentId);
        segmentIds.add(segmentId);
      }
    }
    return { candidatesByWorkoutId, segmentIds: [...segmentIds] };
  }

  static async loadSegmentMatchDefinitionsBulk(segmentIds) {
    const normalizedIds = [...new Set((Array.isArray(segmentIds) ? segmentIds : [])
      .map(Number)
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0))];
    if (normalizedIds.length === 0) {
      return new Map();
    }

    const result = await pool.query(`
      SELECT
        id,
        distance,
        track_blob,
        track_blob_codec,
        gps_bounds::text AS gps_bounds_text
      FROM gps_segments
      WHERE id = ANY($1::bigint[])
    `, [normalizedIds]);
    const rows = await Promise.all(result.rows.map((row) => SegmentDBService.hydrateSegmentTrackRow(row)));
    return new Map(rows.map((row) => [Number(row.id), {
      id: Number(row.id),
      distance: Number(row.distance) || 0,
      geom: row.geom,
      track: row.geom.coordinates.map(([lng, lat]) => ({ lat, lng })),
      bounds: {
        minLat: Number(row.min_lat),
        maxLat: Number(row.max_lat),
        minLng: Number(row.min_lng),
        maxLng: Number(row.max_lng)
      }
    }]));
  }

  static async getOwnedSegmentsForArchive(uid) {
    const result = await pool.query(`
      SELECT
        s.id,
        s.uid,
        s.distance,
        s.duration,
        s.start_lat,
        s.start_lng,
        s.start_name,
        s.start_altitude,
        s.end_lat,
        s.end_lng,
        s.end_name,
        s.end_altitude,
        s.ascent,
        s.altitudes,
        s.points_count,
        s.best_efforts_status,
        0::int AS share_group_count,
        s.track_blob,
        s.track_blob_codec,
        s.gps_bounds::text AS gps_bounds_text
      FROM gps_segments s
      WHERE s.uid = $1
      ORDER BY s.id
    `, [uid]);

    const rows = await Promise.all(
      result.rows.map((row) => SegmentDBService.hydrateSegmentTrackRow(row))
    );
    return rows.map((row) => SegmentDBService.mapSegment(row));
  }

  static async getSegmentById(uid, segmentId) {
    const result = await pool.query(`
      SELECT
        s.id,
        s.uid,
        s.distance,
        s.duration,
        s.start_lat,
        s.start_lng,
        s.start_name,
        s.start_altitude,
        s.end_lat,
        s.end_lng,
        s.end_name,
        s.end_altitude,
        s.ascent,
        s.altitudes,
        s.points_count,
        s.best_efforts_status,
        (
          SELECT COUNT(*)
          FROM gps_segment_group_shares sgs
          WHERE sgs.segment_id = s.id
        )::int AS share_group_count,
        owner.display_name AS owner_display_name,
        owner.email AS owner_email,
        EXISTS (
          SELECT 1
          FROM segment_favorites sf
          WHERE sf.uid = $2
            AND sf.segment_id = s.id
        ) AS is_favorite,
        s.track_blob,
        s.track_blob_codec,
        s.gps_bounds::text AS gps_bounds_text
      FROM gps_segments s
      LEFT JOIN users owner
        ON owner.id = s.uid
      WHERE s.id = $1
        AND (
          s.uid = $2
          OR EXISTS (
            SELECT 1
            FROM gps_segment_group_shares sgs
            INNER JOIN group_members gm
              ON gm.group_id = sgs.group_id
            WHERE sgs.segment_id = s.id
              AND gm.user_id = $2
          )
        )
    `, [segmentId, uid]);

    if (!result.rows[0]) return null;
    return SegmentDBService.mapSegment(await SegmentDBService.hydrateSegmentTrackRow(result.rows[0]));
  }

  static async getAccessibleSegment(uid, segmentId) {
    const result = await pool.query(`
      SELECT s.id, s.uid
      FROM gps_segments s
      WHERE s.id = $1
        AND (
          s.uid = $2
          OR EXISTS (
            SELECT 1
            FROM gps_segment_group_shares sgs
            INNER JOIN group_members gm
              ON gm.group_id = sgs.group_id
            WHERE sgs.segment_id = s.id
              AND gm.user_id = $2
          )
        )
      LIMIT 1
    `, [segmentId, uid]);

    return result.rows[0] || null;
  }

  static async getSegmentSharing(uid, segmentId) {
    const segmentResult = await pool.query(`
      SELECT id, uid
      FROM gps_segments
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [segmentId, uid]);

    if (segmentResult.rowCount === 0) {
      throw new Error("Segment not found");
    }

    const sharesResult = await pool.query(`
      SELECT
        sgs.group_id,
        g.name AS group_name
      FROM gps_segment_group_shares sgs
      INNER JOIN groups g
        ON g.id = sgs.group_id
      WHERE sgs.segment_id = $1
      ORDER BY lower(g.name) ASC, sgs.group_id ASC
    `, [segmentId]);

    const groupIds = sharesResult.rows.map((row) => Number(row.group_id));

    return {
      shareMode: groupIds.length > 0 ? "groups" : "private",
      groupIds,
      groups: sharesResult.rows
    };
  }

  static async updateSegmentSharing(uid, segmentId, payload = {}) {
    const shareMode = String(payload.shareMode || "private").toLowerCase() === "groups"
      ? "groups"
      : "private";
    let newlyPublishedGroupIds = [];

    const requestedGroupIds = [...new Set(
      (Array.isArray(payload.groupIds) ? payload.groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const segmentResult = await client.query(`
        SELECT
          id,
          uid,
          distance,
          duration,
          start_name,
          end_name
        FROM gps_segments
        WHERE id = $1
          AND uid = $2
        LIMIT 1
      `, [segmentId, uid]);

      if (segmentResult.rowCount === 0) {
        throw new Error("Segment not found");
      }

      const previousSharesResult = await client.query(`
        SELECT group_id
        FROM gps_segment_group_shares
        WHERE segment_id = $1
      `, [segmentId]);

      const previousGroupIds = previousSharesResult.rows.map((row) => Number(row.group_id));

      await client.query(`
        DELETE FROM gps_segment_group_shares
        WHERE segment_id = $1
      `, [segmentId]);

      if (shareMode === "groups") {
        if (requestedGroupIds.length === 0) {
          throw new Error("Bitte mindestens eine Gruppe auswaehlen.");
        }

        const groupsResult = await client.query(`
          SELECT group_id
          FROM group_members
          WHERE user_id = $1
            AND group_id = ANY($2::bigint[])
        `, [uid, requestedGroupIds]);

        const allowedGroupIds = groupsResult.rows.map((row) => Number(row.group_id));

        if (allowedGroupIds.length !== requestedGroupIds.length) {
          throw new Error("Mindestens eine Gruppe ist fuer dieses Segment nicht erlaubt.");
        }

        await client.query(`
          INSERT INTO gps_segment_group_shares (segment_id, group_id, shared_by_user_id)
          SELECT
            $1,
            gm.group_id,
            $2
          FROM group_members gm
          WHERE gm.user_id = $2
            AND gm.group_id = ANY($3::bigint[])
          ON CONFLICT (segment_id, group_id) DO NOTHING
        `, [segmentId, uid, allowedGroupIds]);

        newlyPublishedGroupIds = allowedGroupIds.filter((groupId) => !previousGroupIds.includes(groupId));

        if (newlyPublishedGroupIds.length > 0) {
          await CollaborationDBService.createSegmentPublishedFeedEvents({
            groupIds: newlyPublishedGroupIds,
            actorUserId: uid,
            segmentId,
            payload: {
              segmentType: "gps",
              distance: segmentResult.rows[0].distance ?? null,
              duration: segmentResult.rows[0].duration ?? null,
              startName: segmentResult.rows[0].start_name || null,
              endName: segmentResult.rows[0].end_name || null
            }
          });
        }
      }

      await client.query("COMMIT");

      const sharing = await SegmentDBService.getSegmentSharing(uid, segmentId);
      return {
        ...sharing,
        newlyPublishedGroupIds
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async bulkPublishSegmentsToGroup(uid, groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      const error = new Error("Ungueltige Gruppe.");
      error.statusCode = 400;
      throw error;
    }

    const membershipResult = await pool.query(`
      SELECT group_id
      FROM group_members
      WHERE user_id = $1
        AND group_id = $2
      LIMIT 1
    `, [uid, normalizedGroupId]);

    if (membershipResult.rowCount === 0) {
      const error = new Error("Gruppe fuer dieses Segment nicht erlaubt.");
      error.statusCode = 403;
      throw error;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const insertResult = await client.query(`
        WITH candidates AS (
          SELECT
            s.id,
            s.distance,
            s.duration,
            s.start_name,
            s.end_name
          FROM gps_segments s
          WHERE s.uid = $1
            AND NOT EXISTS (
              SELECT 1
              FROM gps_segment_group_shares sgs
              WHERE sgs.segment_id = s.id
                AND sgs.group_id = $2
            )
        )
        INSERT INTO gps_segment_group_shares (segment_id, group_id, shared_by_user_id)
        SELECT
          c.id,
          $2,
          $1
        FROM candidates c
        RETURNING segment_id
      `, [uid, normalizedGroupId]);

      const segmentIds = insertResult.rows.map((row) => Number(row.segment_id));
      let segments = [];

      if (segmentIds.length > 0) {
        const segmentsResult = await client.query(`
          SELECT
            id,
            distance,
            duration,
            start_name,
            end_name
          FROM gps_segments
          WHERE id = ANY($1::bigint[])
        `, [segmentIds]);

        segments = segmentsResult.rows;
      }

      await client.query("COMMIT");

      return {
        groupId: normalizedGroupId,
        segmentIds,
        segments,
        publishedCount: segmentIds.length
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async getGPSSegmentByWorkout(uid, wid){
    await WorkoutSharingService.getAccessibleWorkout(uid, wid);

    const dataQuery = `
    SELECT 
      id, 
      sid,
      wid,
      uid,
      start_time, 
      duration, 
      start_offset, 
      end_offset, 
      avg_power, 
      avg_heart_rate, 
      avg_cadence, 
      avg_speed
    FROM v_gps_segment_best_efforts
    WHERE wid = $1

  `;

    const dataParams = [
      wid
    ];

    const dataResult = await pool.query(dataQuery, dataParams);
    return dataResult;
  }

  static async getBestEffortsBySegment(uid, segid, page, size, sort, filter, scope = "mine", perUser = "all") {

    const offset = (page - 1) * size;

    const filter_all = [];
    //filter_all.push({ field: 'uid', type: '=', value: uid });
    filter_all.push({ field: 'sid', type: '=', value: segid });
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(SegmentDBService.allowedColumns, SegmentDBService.numericFields, sort, filter_all);

    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";
    const normalizedPerUser = ["all", "1", "3"].includes(String(perUser).toLowerCase())
      ? String(perUser).toLowerCase()
      : "all";
    const perUserLimit = normalizedPerUser === "all" ? null : Number(normalizedPerUser);

    let accessPredicate = `v.uid = $1`;

    if (normalizedScope === "shared") {
      accessPredicate = `
        v.uid <> $1
        AND EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = v.wid
            AND gm.user_id = $1
        )
      `;
    } else if (normalizedScope === "all") {
      accessPredicate = `
        v.uid = $1
        OR EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = v.wid
            AND gm.user_id = $1
        )
      `;
    }

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = `WHERE (${accessPredicate})`;
    let sqlParams = [uid, ...params];
    if (whereSQL) {
      const adjustedWhere = whereSQL.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + 1}`);
      baseWhere += ` AND (${adjustedWhere.replace("WHERE ", "")})`;
    }

    const userRankWhere = Number.isInteger(perUserLimit) && perUserLimit > 0
      ? `WHERE ranked.user_rank <= ${perUserLimit}`
      : "";

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------

    const dataQuery = `
    WITH base AS (
      SELECT 
        v.id, 
        v.sid,
        v.wid,
        v.uid,
        v.start_time, 
        v.duration, 
        v.start_offset, 
        v.end_offset, 
        v.avg_power, 
        v.avg_heart_rate, 
        v.avg_cadence, 
        v.avg_speed
      FROM v_gps_segment_best_efforts v
      ${baseWhere}
    ),
    ranked AS (
      SELECT
        base.*,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid
          ORDER BY base.duration ASC
        ) AS rn,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid, base.uid
          ORDER BY base.duration ASC
        ) AS user_rank
      FROM base
    )
    SELECT 
      ranked.id,
      ranked.sid,
      ranked.wid,
      ranked.uid,
      ranked.start_time,
      ranked.duration,
      ranked.start_offset,
      ranked.end_offset,
      ranked.avg_power,
      ranked.avg_heart_rate,
      ranked.avg_cadence,
      owner.display_name AS owner_display_name,
      owner.email AS owner_email,
      ranked.avg_speed,
      ranked.rn
    FROM ranked
    LEFT JOIN users owner
      ON owner.id = ranked.uid
    ${userRankWhere}
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
    WITH base AS (
      SELECT 
        v.id,
        v.sid,
        v.uid,
        v.duration
      FROM v_gps_segment_best_efforts v
      ${baseWhere}
    ),
    ranked AS (
      SELECT
        base.*,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid, base.uid
          ORDER BY base.duration ASC
        ) AS user_rank
      FROM base
    )
    SELECT COUNT(*) AS total
    FROM ranked
    ${userRankWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);


    return {
      data: dataResult.rows,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords
    };
  }

  static async getBestEffortsStatus(uid, segmentId) {
    const result = await pool.query(`
      SELECT
        id,
        best_efforts_status,
        best_efforts_error
      FROM gps_segments
      WHERE id = $1
        AND uid = $2
    `, [segmentId, uid]);

    return result.rows[0] ?? null;
  }





  static async querySegmentsByBounds(uid, bounds, excludeIds, limit, scope = "mine", favoritesOnly = false) {
    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";

    let accessPredicate = `s.uid = $1`;

    if (normalizedScope === "shared") {
      accessPredicate = `
        s.uid <> $1
        AND EXISTS (
          SELECT 1
          FROM gps_segment_group_shares sgs
          INNER JOIN group_members gm
            ON gm.group_id = sgs.group_id
          WHERE sgs.segment_id = s.id
            AND gm.user_id = $1
        )
      `;
    } else if (normalizedScope === "all") {
      accessPredicate = `
        s.uid = $1
        OR EXISTS (
          SELECT 1
          FROM gps_segment_group_shares sgs
          INNER JOIN group_members gm
            ON gm.group_id = sgs.group_id
          WHERE sgs.segment_id = s.id
            AND gm.user_id = $1
        )
      `;
    }

    const result = await pool.query(`
  SELECT
    s.id,
    s.uid,
    s.created_at,
    s.distance,
    s.duration,
    s.start_lat,
    s.start_lng,
    s.start_name,
    s.start_altitude,
    s.end_lat,
    s.end_lng,
    s.end_name,
    s.end_altitude,
    s.ascent,
    s.altitudes,
    s.points_count,
    s.best_efforts_status,
    (
      SELECT COUNT(*)
      FROM gps_segment_group_shares sgs
      WHERE sgs.segment_id = s.id
    )::int AS share_group_count,
    owner.display_name AS owner_display_name,
    owner.email AS owner_email,
    EXISTS (
      SELECT 1
      FROM segment_favorites sf
      WHERE sf.uid = $1
        AND sf.segment_id = s.id
    ) AS is_favorite,
    s.track_blob,
    s.track_blob_codec,
    s.gps_bounds::text AS gps_bounds_text
  FROM gps_segments s
  LEFT JOIN users owner
    ON owner.id = s.uid
  WHERE (${accessPredicate})
    AND (
      $5::boolean = false
      OR EXISTS (
        SELECT 1
        FROM segment_favorites sf_filter
        WHERE sf_filter.uid = $1
          AND sf_filter.segment_id = s.id
      )
    )
    AND (
      $2::int[] IS NULL
      OR NOT (s.id = ANY($2))
    )
    AND s.gps_bounds && $3::box
  ORDER BY s.created_at DESC
  LIMIT $4
`, [
      uid,
      excludeIds,
      toPostgresBox(bounds),
      limit,
      favoritesOnly
    ]);

    result.rows = await Promise.all(
      result.rows.map((row) => SegmentDBService.hydrateSegmentTrackRow(row))
    );
    return result;


  }

  static async deleteSegmentById(uid, segmentId) {
    const result = await pool.query(`
      DELETE FROM gps_segments
      WHERE id = $1
        AND uid = $2
      RETURNING id
    `, [segmentId, uid]);

    return result.rows[0] ?? null;
  }

  static async updateBestEffortsStatus(uid, segmentIds, status, errorMessage = null) {
    if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
      return [];
    }

    const result = await pool.query(`
      UPDATE gps_segments
      SET
        best_efforts_status = $3,
        best_efforts_error = $4,
        updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND uid = $2
      RETURNING id
    `, [segmentIds, uid, status, errorMessage]);

    return result.rows;
  }

  static chunkArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  static compareSegmentMatchesByDuration(left, right) {
    const leftDuration = Number(left?.end_offset) - Number(left?.start_offset);
    const rightDuration = Number(right?.end_offset) - Number(right?.start_offset);
    return leftDuration - rightDuration
      || Number(left?.workout_id) - Number(right?.workout_id)
      || Number(left?.start_offset) - Number(right?.start_offset);
  }

  static keepFastestSegmentMatches(matches, maxMatches) {
    if (!Number.isInteger(maxMatches) || maxMatches <= 0 || matches.length <= maxMatches) {
      return matches;
    }
    matches.sort(this.compareSegmentMatchesByDuration);
    matches.length = maxMatches;
    return matches;
  }

  static async materializeOnDemandSegmentBestEfforts(uid, segmentId, options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options?.limit) || 100));
    const scanResult = await this.scanWorkoutsForSegments(uid, [segmentId], {
      includeProfile: true,
      includeExistingBestEfforts: true,
      includeSharedWorkouts: false,
      includeMetrics: false,
      maxMatches: limit
    });
    const matches = scanResult.matches;
    const workoutIds = [...new Set(matches.map((match) => Number(match.workout_id)))];
    const profile = {
      ...scanResult.profile,
      loadWorkoutMetadataMs: 0,
      loadWorkoutObjectsMs: 0,
      calculateAveragesMs: 0,
      loadWorkoutBlobRowsMs: 0,
      decompressWorkoutStreamsMs: 0,
      decodeWorkoutStreamsMs: 0,
      workoutStreamCompressedBytes: 0,
      workoutStreamRawBytes: 0,
      directWorkoutRangeCount: 0,
      fallbackWorkoutObjectCount: 0
    };

    if (workoutIds.length === 0) {
      return {
        data: [],
        total_records: scanResult.profile.rawMatchCount,
        returned_records: 0,
        profile
      };
    }

    const workoutObjectsStartedAt = performance.now();
    const profiledWorkoutObjects = await WorkoutDBService.getWorkoutRangeAveragesWithProfile(
      matches,
      { direct: SEGMENT_BEST_EFFORTS_DIRECT_AVERAGES }
    );
    profile.loadWorkoutObjectsMs = performance.now() - workoutObjectsStartedAt;
    profile.loadWorkoutBlobRowsMs = profiledWorkoutObjects.profile.queryMs;
    profile.decompressWorkoutStreamsMs = profiledWorkoutObjects.profile.decompressMs;
    profile.decodeWorkoutStreamsMs = profiledWorkoutObjects.profile.decodeWorkoutMs;
    profile.workoutStreamCompressedBytes = profiledWorkoutObjects.profile.compressedBytes;
    profile.workoutStreamRawBytes = profiledWorkoutObjects.profile.rawBytes;
    profile.directWorkoutRangeCount = profiledWorkoutObjects.profile.directRangeCount;
    profile.fallbackWorkoutObjectCount = profiledWorkoutObjects.profile.fallbackWorkoutCount;

    const segmentDistance = Number((await this.getSegmentDistanceMap([segmentId])).get(Number(segmentId))) || 0;
    const averagesStartedAt = performance.now();
    const data = [];
    for (const match of matches) {
      const workoutId = Number(match.workout_id);
      const metadata = profiledWorkoutObjects.metadataByWorkoutId.get(workoutId);
      const averages = profiledWorkoutObjects.averagesByRange.get(
        WorkoutDBService.workoutRangeKey(workoutId, match.start_offset, match.end_offset)
      );
      if (!averages || !metadata) continue;

      const duration = Number(match.end_offset) - Number(match.start_offset);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      data.push({
        id: null,
        sid: Number(segmentId),
        wid: workoutId,
        uid: Number(metadata.uid),
        start_time: metadata.start_time,
        duration,
        start_offset: Number(match.start_offset),
        end_offset: Number(match.end_offset),
        avg_power: Math.round(averages.power ?? 0),
        avg_heart_rate: Math.round(averages.hr ?? 0),
        avg_cadence: Math.round(averages.cadence ?? 0),
        avg_speed: this.calculateNormalizedSegmentSpeed(segmentDistance, duration),
        owner_display_name: metadata.owner_display_name,
        owner_email: metadata.owner_email
      });
    }
    profile.calculateAveragesMs = performance.now() - averagesStartedAt;

    data.sort((left, right) => Number(left.duration) - Number(right.duration)
      || Number(left.wid) - Number(right.wid)
      || Number(left.start_offset) - Number(right.start_offset));
    data.forEach((row, index) => {
      row.rn = index + 1;
    });

    return {
      data,
      total_records: scanResult.profile.rawMatchCount,
      returned_records: data.length,
      profile
    };
  }

  static async scanWorkoutsForSegments(uid, segments, options = {}) {
    const includeProfile = options?.includeProfile === true;
    const includeExistingBestEfforts = options?.includeExistingBestEfforts === true;
    const includeSharedWorkouts = options?.includeSharedWorkouts !== false;
    const includeMetrics = options?.includeMetrics !== false;
    const useCompactMatcher = options?.compactMatcher == null
      ? SEGMENT_BEST_EFFORTS_COMPACT_MATCHER
      : options.compactMatcher === true;
    const maxMatches = Number.isInteger(Number(options?.maxMatches))
      ? Math.max(1, Number(options.maxMatches))
      : null;
    const segmentIds = [...new Set((Array.isArray(segments) ? segments : [])
      .map((segment) => Number(segment?.id ?? segment))
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0))];
    const profile = {
      loadSegmentDefinitionsMs: 0,
      loadCandidateRowsMs: 0,
      decodeWorkoutTracksMs: 0,
      matchSegmentsMs: 0,
      loadWorkoutObjectsMs: 0,
      calculateAveragesMs: 0,
      candidateWorkoutCount: 0,
      candidatePairCount: 0,
      matchedWorkoutCount: 0,
      rawMatchCount: 0,
      matchCount: 0,
      workoutChunkSize: 100,
      matcherMode: useCompactMatcher ? "compact-e5" : "object"
    };
    if (segmentIds.length === 0) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const loadSegmentDefinitionsStartedAt = Date.now();
    const segmentDefinitionsById = await this.loadSegmentMatchDefinitionsBulk(segmentIds);
    const compactSegmentDefinitionsById = useCompactMatcher
      ? new Map(prepareCompactGpsSegmentDefinitions([...segmentDefinitionsById.values()])
        .map((segment) => [Number(segment.id), segment]))
      : null;
    profile.loadSegmentDefinitionsMs = Date.now() - loadSegmentDefinitionsStartedAt;

    const loadCandidateRowsStartedAt = Date.now();
    const candidateRows = await FileDBService.getMatchingWorkoutCandidatesForSegments(
      segmentIds,
      uid,
      { includeExistingBestEfforts, includeSharedWorkouts }
    );
    profile.loadCandidateRowsMs = Date.now() - loadCandidateRowsStartedAt;
    profile.candidateWorkoutCount = candidateRows.length;
    profile.candidatePairCount = candidateRows.reduce(
      (total, row) => total + (Array.isArray(row.segment_ids) ? row.segment_ids.length : 0),
      0
    );

    const allMatches = [];
    for (const rows of this.chunkArray(candidateRows, profile.workoutChunkSize)) {
      const matchesByWorkoutId = new Map();

      for (const row of rows) {
        const workoutId = Number(row.wid);
        const segmentIdsForWorkout = Array.isArray(row.segment_ids) ? row.segment_ids : [];
        if (segmentIdsForWorkout.length === 0) continue;

        const decodeStartedAt = Date.now();
        const decodedTrack = useCompactMatcher
          ? await GpsTrackBlobService.decodeCompressedCompact(row.gps_track_blob, {
              codec: row.gps_track_blob_codec || "brotli",
              includeSlotIndices: true
            })
          : await GpsTrackBlobService.decodeRowTrack(row, { includeGeoJson: false });
        profile.decodeWorkoutTracksMs += Date.now() - decodeStartedAt;

        const candidateSegments = segmentIdsForWorkout
          .map((segmentId) => useCompactMatcher
            ? compactSegmentDefinitionsById.get(Number(segmentId))
            : segmentDefinitionsById.get(Number(segmentId)))
          .filter(Boolean);
        if (decodedTrack.pointCount === 0 || candidateSegments.length === 0) continue;

        const sampleRate = Number(decodedTrack.sampleRateGps) > 0
          ? Number(decodedTrack.sampleRateGps)
          : Number(row.wsamplerate) || 1;
        decodedTrack.sampleRateGps = sampleRate;
        const matchStartedAt = Date.now();
        const matches = useCompactMatcher
          ? matchCompactGpsSegmentBestEfforts(decodedTrack, candidateSegments).matches
          : matchGpsSegmentBestEfforts({
              track: decodedTrack.points,
              segments: Array.isArray(decodedTrack.segments) ? decodedTrack.segments : [],
              bbox: decodedTrack.bbox,
              sampleRateSeconds: sampleRate
            }, candidateSegments).matches;
        profile.matchSegmentsMs += Date.now() - matchStartedAt;
        profile.rawMatchCount += matches.length;
        if (matches.length > 0) {
          matchesByWorkoutId.set(workoutId, matches.map((match) => ({
            workout_id: workoutId,
            segment_id: Number(match.segmentId),
            start_offset: Number(match.startOffset),
            end_offset: Number(match.endOffset)
          })));
        }
      }

      const matchedWorkoutIds = [...matchesByWorkoutId.keys()];
      if (matchedWorkoutIds.length === 0) continue;

      if (!includeMetrics) {
        for (const matches of matchesByWorkoutId.values()) {
          allMatches.push(...matches);
        }
        this.keepFastestSegmentMatches(allMatches, maxMatches);
        continue;
      }

      const loadWorkoutObjectsStartedAt = Date.now();
      const rawWorkoutObjects = await WorkoutDBService.getWorkouts(matchedWorkoutIds);
      const workoutObjects = new Map(
        [...rawWorkoutObjects.entries()].map(([workoutId, workout]) => [Number(workoutId), workout])
      );
      profile.loadWorkoutObjectsMs += Date.now() - loadWorkoutObjectsStartedAt;

      const calculateAveragesStartedAt = Date.now();
      for (const [workoutId, matches] of matchesByWorkoutId) {
        const workoutObject = workoutObjects.get(workoutId);
        if (!workoutObject) continue;
        for (const match of matches) {
          Object.assign(match, workoutObject.getAverages(match.start_offset, match.end_offset));
          allMatches.push(match);
        }
      }
      profile.calculateAveragesMs += Date.now() - calculateAveragesStartedAt;
      this.keepFastestSegmentMatches(allMatches, maxMatches);
    }

    if (maxMatches) allMatches.sort(this.compareSegmentMatchesByDuration);
    profile.matchCount = allMatches.length;
    profile.matchedWorkoutCount = new Set(allMatches.map((match) => Number(match.workout_id))).size;
    return includeProfile ? { matches: allMatches, profile } : allMatches;
  }

  static async scanWorkoutsForSegment(uid, segment, options = {}) {
    const includeProfile = options?.includeProfile === true;
    const profile = {
      loadCandidateRowsMs: 0,
      decodeCandidateTracksMs: 0,
      matchSegmentsMs: 0,
      loadWorkoutObjectsMs: 0,
      calculateAveragesMs: 0,
      candidateCount: 0,
      matchedWorkoutCount: 0,
      matchCount: 0
    };

    if (!segment?.id || !segment?.bbox) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const loadCandidateRowsStartedAt = Date.now();
    const candidateRows = await FileDBService.getMatchingWorkoutCandidatesV2(
      segment.bbox,
      segment.id,
      uid
    );
    profile.loadCandidateRowsMs = Date.now() - loadCandidateRowsStartedAt;
    profile.candidateCount = candidateRows.length;

    const decodeCandidateTracksStartedAt = Date.now();
    const candidates = await Promise.all(candidateRows.map(async (row) => ({
      ...row,
      decodedTrack: await GpsTrackBlobService.decodeRowTrack(row, { includeGeoJson: false })
    })));
    profile.decodeCandidateTracksMs = Date.now() - decodeCandidateTracksStartedAt;

    const segLine = segment.track.map(({ lat, lng }) => ({ lat, lng }));
    const matches = [];

    const matchSegmentsStartedAt = Date.now();
    candidates.forEach((cand) => {
      const decodedTrack = cand.decodedTrack;
      const wotrack = {
        wid: cand.wid,
        track: decodedTrack.points,
        segments: decodedTrack.segments,
        sampleRate: Number(decodedTrack.sampleRateGps) > 0
          ? Number(decodedTrack.sampleRateGps)
          : cand.wsamplerate
      };

      const found = SegmentMatcher.findMatches(wotrack, {
        id: segment.id,
        track: segLine
      });

      matches.push(...found);
    });
    profile.matchSegmentsMs = Date.now() - matchSegmentsStartedAt;
    profile.matchCount = matches.length;

    const uniqueIds = [...new Set(matches.map((match) => match.workout_id))];
    profile.matchedWorkoutCount = uniqueIds.length;

    if (uniqueIds.length > 0) {
      const loadWorkoutObjectsStartedAt = Date.now();
      const rawWorkoutObjects = await WorkoutDBService.getWorkouts(uniqueIds);
      const workoutObjects = new Map(
        [...rawWorkoutObjects.entries()].map(([workoutId, workout]) => [Number(workoutId), workout])
      );
      profile.loadWorkoutObjectsMs = Date.now() - loadWorkoutObjectsStartedAt;

      const calculateAveragesStartedAt = Date.now();
      for (const match of matches) {
        const workoutObject = workoutObjects.get(Number(match.workout_id));
        if (!workoutObject) continue;

        const averages = workoutObject.getAverages(match.start_offset, match.end_offset);
        Object.assign(match, averages);
      }
      profile.calculateAveragesMs = Date.now() - calculateAveragesStartedAt;
    }

    return includeProfile ? { matches, profile } : matches;
  }

  static async getSharedSegmentRescanTargetsForWorkout(workoutId, workoutOwnerId, groupIds = []) {
    const normalizedGroupIds = [...new Set(
      (Array.isArray(groupIds) ? groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    if (!workoutId || normalizedGroupIds.length === 0) {
      return [];
    }

    const result = await pool.query(`
      SELECT DISTINCT
        s.id,
        s.uid
      FROM workouts w
      INNER JOIN gps_segment_group_shares sgs
        ON sgs.group_id = ANY($3::bigint[])
      INNER JOIN gps_segments s
        ON s.id = sgs.segment_id
      WHERE w.id = $1
        AND w.uid = $2
        AND s.uid <> $2
        AND s.gps_bounds && w.gps_bounds
    `, [workoutId, workoutOwnerId, normalizedGroupIds]);

    return result.rows.map((row) => ({
      id: Number(row.id),
      uid: Number(row.uid)
    }));
  }

  static async getSharedSegmentRescanTargetsForGroup(groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      return [];
    }

    const result = await pool.query(`
      SELECT DISTINCT
        s.id,
        s.uid
      FROM gps_segments s
      INNER JOIN gps_segment_group_shares sgs
        ON sgs.segment_id = s.id
      WHERE sgs.group_id = $1
      ORDER BY s.uid, s.id
    `, [normalizedGroupId]);

    return result.rows.map((row) => ({
      id: Number(row.id),
      uid: Number(row.uid)
    }));
  }

  static async rescanSegmentBestEffortsForWorkout(uid, workoutId, options = {}) {
    const includeProfile = options?.includeProfile === true;
    const includeExistingBestEfforts = options?.includeExistingBestEfforts === true;
    const profile = {
      loadWorkoutTrackMs: 0,
      buildBoundsMs: 0,
      loadSegmentCandidatesMs: 0,
      matchSegmentsMs: 0,
      loadWorkoutObjectMs: 0,
      persistBestEffortsMs: 0,
      candidateCount: 0,
      rawMatchCount: 0
    };

    const loadWorkoutTrackStartedAt = Date.now();
    const workoutRowResult = await pool.query(`
      SELECT
        id,
        samplerategps,
        gps_track_blob,
        gps_track_blob_codec
      FROM workouts
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [workoutId, uid]);
    profile.loadWorkoutTrackMs += Date.now() - loadWorkoutTrackStartedAt;

    if (workoutRowResult.rowCount === 0) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const workoutRow = workoutRowResult.rows[0];
    const decodeTrackStartedAt = Date.now();
    const decodedTrack = await GpsTrackBlobService.decodeRowTrack({
      gps_track_blob: workoutRow.gps_track_blob,
      gps_track_blob_codec: workoutRow.gps_track_blob_codec,
      samplerategps: workoutRow.samplerategps
    }, { includeGeoJson: false });
    profile.loadWorkoutTrackMs += Date.now() - decodeTrackStartedAt;
    const track = decodedTrack.points;
    const trackSegments = Array.isArray(decodedTrack.segments) ? decodedTrack.segments : [];

    if (track.length === 0) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const buildBoundsStartedAt = Date.now();
    const bounds = track.reduce((acc, point) => ({
      minLat: Math.min(acc.minLat, point.lat),
      maxLat: Math.max(acc.maxLat, point.lat),
      minLng: Math.min(acc.minLng, point.lng),
      maxLng: Math.max(acc.maxLng, point.lng)
    }), {
      minLat: Infinity,
      maxLat: -Infinity,
      minLng: Infinity,
      maxLng: -Infinity
    });
    profile.buildBoundsMs += Date.now() - buildBoundsStartedAt;

    const loadSegmentCandidatesStartedAt = Date.now();
    const candidates = await SegmentDBService.getMatchingSegmentCandidatesV2(bounds, uid, workoutId, {
      includeExistingBestEfforts
    });
    profile.loadSegmentCandidatesMs += Date.now() - loadSegmentCandidatesStartedAt;
    profile.candidateCount = Array.isArray(candidates) ? candidates.length : 0;

    if (candidates.length === 0) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const workout = {
      id: workoutId,
      track,
      trackSegments,
      sampleRate: Number(decodedTrack.sampleRateGps) > 0
        ? Number(decodedTrack.sampleRateGps)
        : workoutRow.samplerategps
    };

    const matchSegmentsStartedAt = Date.now();
    const matches = SegmentDBService.matchSegments(workout, candidates);
    profile.matchSegmentsMs += Date.now() - matchSegmentsStartedAt;
    profile.rawMatchCount = Array.isArray(matches) ? matches.length : 0;
    if (matches.length === 0) {
      return includeProfile ? { matches: [], profile } : [];
    }

    const loadWorkoutObjectStartedAt = Date.now();
    const workoutObject = await WorkoutDBService.getWorkout(workoutId);
    profile.loadWorkoutObjectMs += Date.now() - loadWorkoutObjectStartedAt;

    const persistBestEffortsStartedAt = Date.now();
    await SegmentDBService.storeSegmentBestEfforts(matches, workoutObject);
    profile.persistBestEffortsMs += Date.now() - persistBestEffortsStartedAt;

    return includeProfile ? { matches, profile } : matches;
  }

  static async rescanSegmentBestEffortsForWorkoutsBatch(uid, workoutIds, options = {}) {
    const includeExistingBestEfforts = options?.includeExistingBestEfforts === true;
    const normalizedIds = [...new Set((Array.isArray(workoutIds) ? workoutIds : [])
      .map(Number)
      .filter(Number.isInteger))];
    if (!uid || normalizedIds.length === 0) {
      return [];
    }

    const loadWorkoutTrackStartedAt = Date.now();
    const trackRowsByWorkoutId = await WorkoutDBService.loadSimilarityTrackRowsBulk(uid, normalizedIds);
    const loadWorkoutTrackRowsMs = Date.now() - loadWorkoutTrackStartedAt;

    const loadSegmentCandidateIdsStartedAt = Date.now();
    const { candidatesByWorkoutId, segmentIds } = await this.getMatchingSegmentCandidateIdsForWorkoutsBulk(
      uid,
      normalizedIds,
      { includeExistingBestEfforts }
    );
    const loadSegmentCandidateIdsMs = Date.now() - loadSegmentCandidateIdsStartedAt;

    const loadSegmentDefinitionsStartedAt = Date.now();
    const segmentDefinitionsById = await this.loadSegmentMatchDefinitionsBulk(segmentIds);
    const loadSegmentDefinitionsMs = Date.now() - loadSegmentDefinitionsStartedAt;
    const loadSegmentCandidatesMs = loadSegmentCandidateIdsMs + loadSegmentDefinitionsMs;

    const matchesByWorkoutId = new Map();
    const profilesByWorkoutId = new Map();
    const allMatches = [];
    let candidateOccurrenceCount = 0;
    for (const workoutId of normalizedIds) {
      const profile = {
        loadWorkoutTrackMs: 0,
        buildBoundsMs: 0,
        loadSegmentCandidatesMs: 0,
        matchSegmentsMs: 0,
        loadWorkoutObjectMs: 0,
        persistBestEffortsMs: 0,
        candidateCount: 0,
        rawMatchCount: 0
      };
      const row = trackRowsByWorkoutId.get(workoutId);
      let matches = [];
      if (row) {
        const decodeTrackStartedAt = Date.now();
        const decodedTrack = await GpsTrackBlobService.decodeRowTrack(row, { includeGeoJson: false });
        profile.loadWorkoutTrackMs += Date.now() - decodeTrackStartedAt;
        const candidateIds = candidatesByWorkoutId.get(workoutId) || [];
        const candidates = candidateIds
          .map((segmentId) => segmentDefinitionsById.get(segmentId))
          .filter(Boolean);
        profile.candidateCount = candidates.length;
        candidateOccurrenceCount += candidates.length;

        if (decodedTrack.points.length > 0 && candidates.length > 0) {
          const workout = {
            id: workoutId,
            track: decodedTrack.points,
            trackSegments: Array.isArray(decodedTrack.segments) ? decodedTrack.segments : [],
            sampleRate: Number(decodedTrack.sampleRateGps) > 0
              ? Number(decodedTrack.sampleRateGps)
              : row.samplerategps
          };
          const matchSegmentsStartedAt = Date.now();
          matches = this.matchSegments(workout, candidates);
          profile.matchSegmentsMs += Date.now() - matchSegmentsStartedAt;
          profile.rawMatchCount = matches.length;
          allMatches.push(...matches);
        }
      }
      matchesByWorkoutId.set(workoutId, matches);
      profilesByWorkoutId.set(workoutId, profile);
    }

    const matchedWorkoutIds = [...new Set(allMatches.map((match) => Number(match.workout_id)))];
    const loadWorkoutObjectsStartedAt = Date.now();
    const rawWorkoutObjectsById = matchedWorkoutIds.length > 0
      ? await WorkoutDBService.getWorkouts(matchedWorkoutIds)
      : new Map();
    const workoutObjectsById = new Map(
      [...rawWorkoutObjectsById.entries()].map(([workoutId, workout]) => [Number(workoutId), workout])
    );
    const loadWorkoutObjectMs = Date.now() - loadWorkoutObjectsStartedAt;

    const persistBestEffortsStartedAt = Date.now();
    const persistResult = await this.storeSegmentBestEffortsForWorkoutsBulk(
      allMatches,
      workoutObjectsById,
      segmentDefinitionsById
    );
    const persistBestEffortsMs = Date.now() - persistBestEffortsStartedAt;

    const batchSize = normalizedIds.length;
    const sharedTrackLoadMs = loadWorkoutTrackRowsMs / batchSize;
    const sharedCandidateLoadMs = loadSegmentCandidatesMs / batchSize;
    const sharedWorkoutObjectMs = loadWorkoutObjectMs / batchSize;
    const sharedPersistMs = persistBestEffortsMs / batchSize;
    const segmentCacheReuseRatio = segmentDefinitionsById.size > 0
      ? candidateOccurrenceCount / segmentDefinitionsById.size
      : 0;

    return normalizedIds.map((workoutId) => {
      const profile = profilesByWorkoutId.get(workoutId);
      profile.loadWorkoutTrackMs += sharedTrackLoadMs;
      profile.loadSegmentCandidatesMs += sharedCandidateLoadMs;
      profile.loadWorkoutObjectMs += sharedWorkoutObjectMs;
      profile.persistBestEffortsMs += sharedPersistMs;
      profile.batchSize = batchSize;
      profile.loadWorkoutTrackRowsMs = sharedTrackLoadMs;
      profile.loadSegmentCandidateIdsMs = loadSegmentCandidateIdsMs / batchSize;
      profile.loadSegmentDefinitionsMs = loadSegmentDefinitionsMs / batchSize;
      profile.segmentCacheEntriesPerWorkout = segmentDefinitionsById.size / batchSize;
      profile.segmentCacheReuseRatio = segmentCacheReuseRatio;
      profile.matchedWorkoutRatio = matchedWorkoutIds.length / batchSize;
      profile.insertedBestEffortsPerWorkout = Number(persistResult.insertedCount || 0) / batchSize;
      const elapsedMs = profile.loadWorkoutTrackMs
        + profile.loadSegmentCandidatesMs
        + profile.matchSegmentsMs
        + profile.loadWorkoutObjectMs
        + profile.persistBestEffortsMs;
      return {
        workoutId,
        matches: matchesByWorkoutId.get(workoutId) || [],
        profile,
        elapsedMs
      };
    });
  }

  static async insertGpsSegmentsBulk(uid, segments) {
    if (!segments || segments.length === 0) return [];

    const ids = [];
    const uids = [];
    const distances = [];
    const durations = [];

    const startLats = [];
    const startLngs = [];
    const startNames = [];
    const startAltitudes = [];

    const endLats = [];
    const endLngs = [];
    const endNames = [];
    const endAltitudes = [];

    const ascents = [];
    const pointCounts = [];
    const altitudes = [];
    const bestEffortsStatuses = [];

    const boundsBoxes = [];
    const trackBlobs = [];
    const trackBlobCodecs = [];

    for (const seg of segments) {
      ids.push(seg.id);
      uids.push(uid);

      distances.push(seg.distance ?? null);
      durations.push(seg.duration ?? null);

      startLats.push(seg.start?.lat ?? null);
      startLngs.push(seg.start?.lng ?? null);
      startNames.push(seg.start?.name ?? null);
      startAltitudes.push(seg.start?.altitude ?? null);

      endLats.push(seg.end?.lat ?? null);
      endLngs.push(seg.end?.lng ?? null);
      endNames.push(seg.end?.name ?? null);
      endAltitudes.push(seg.end?.altitude ?? null);

      ascents.push(seg.ascent ?? null);
      bestEffortsStatuses.push(seg.bestEffortsStatus ?? "queued");

      const altis = seg.track.map(t => t.ele ?? null);
      altitudes.push(JSON.stringify(altis));

      pointCounts.push(seg.track.length);

      const bbox = seg.track.reduce((acc, point) => ({
        minLat: Math.min(acc.minLat, Number(point.lat)),
        maxLat: Math.max(acc.maxLat, Number(point.lat)),
        minLng: Math.min(acc.minLng, Number(point.lng)),
        maxLng: Math.max(acc.maxLng, Number(point.lng))
      }), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });
      boundsBoxes.push(toPostgresBox(bbox));
      trackBlobs.push(await SegmentTrackBlobService.encode(seg.track, { codec: "brotli" }));
      trackBlobCodecs.push("brotli");
    }

    const query = `
    INSERT INTO gps_segments (
      uid,
      distance,
      duration,

      start_lat,
      start_lng,
      start_name,
      start_altitude,

      end_lat,
      end_lng,
      end_name,
      end_altitude,

      ascent,
      points_count,
      altitudes,
      best_efforts_status,

      gps_bounds,
      track_blob,
      track_blob_codec
    )
    SELECT
      u.uid,
      u.distance,
      u.duration,

      u.start_lat,
      u.start_lng,
      u.start_name,
      u.start_altitude,

      u.end_lat,
      u.end_lng,
      u.end_name,
      u.end_altitude,

      u.ascent,
      u.points_count,
      u.altitudes,
      u.best_efforts_status,

      u.gps_bounds::box,
      u.track_blob,
      u.track_blob_codec

    FROM UNNEST(
      $1::int[],
      $2::float8[],
      $3::float8[],

      $4::float8[],
      $5::float8[],
      $6::text[],
      $7::float8[],

      $8::float8[],
      $9::float8[],
      $10::text[],
      $11::float8[],

      $12::float8[],
      $13::int[],
      $14::jsonb[],
      $15::text[],
      $16::text[],
      $17::bytea[],
      $18::text[]
    ) AS u(
      uid,
      distance,
      duration,

      start_lat,
      start_lng,
      start_name,
      start_altitude,

      end_lat,
      end_lng,
      end_name,
      end_altitude,

      ascent,
      points_count,
      altitudes,
      best_efforts_status,
      gps_bounds,
      track_blob,
      track_blob_codec
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING 
        id,
    uid,
    distance,
    duration,
    start_lat,
    start_lng,
    start_name,
    start_altitude,
    end_lat,
    end_lng,
    end_name,
    end_altitude,
    ascent,
    altitudes,
    points_count,
    best_efforts_status,
    track_blob,
    track_blob_codec,
    gps_bounds::text AS gps_bounds_text;
  `;

    const values = [
      uids,
      distances,
      durations,

      startLats,
      startLngs,
      startNames,
      startAltitudes,

      endLats,
      endLngs,
      endNames,
      endAltitudes,

      ascents,
      pointCounts,
      altitudes,
      bestEffortsStatuses,
      boundsBoxes,
      trackBlobs,
      trackBlobCodecs
    ];

    const result = await pool.query(query, values);
    return Promise.all(result.rows.map((row) => SegmentDBService.hydrateSegmentTrackRow(row)));
  }


  static mapSegment(row, rowstate = 'DB') {
    const merged = [];
    for (let i = 0; i < row.points_count; ++i) {
      const cc = row.geom_geojson.coordinates[i];
      const ele = row.altitudes[i];
      merged.push({
        lat: cc[1],
        lng: cc[0],
        ele: ele
      });

    }

    return {

      id: row.id,
      uid: row.uid,
      ownerDisplayName: row.owner_display_name || null,
      ownerEmail: row.owner_email || null,
      distance: row.distance,
      duration: row.duration,
      ascent: row.ascent,
      points_count: row.points_count,
      bestEffortsStatus: row.best_efforts_status,
      isFavorite: !!row.is_favorite,
      shareGroupCount: Number(row.share_group_count || 0),

      start: {
        lat: row.start_lat,
        lng: row.start_lng,
        name: row.start_name,
        altitude: row.start_altitude
      },

      end: {
        lat: row.end_lat,
        lng: row.end_lng,
        name: row.end_name,
        altitude: row.end_altitude

      },
      track: merged,

      // 🔥 Track umwandeln
      /*track: row.geom_geojson.coordinates.map(([lng, lat]) => ({
        lat,
        lng
      })),*/



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
