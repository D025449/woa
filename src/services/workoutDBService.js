import pool from "./database.js";
import Workout from "../shared/Workout.js";
import S3Service from "./s3Service.js";
import pgPromise from "pg-promise";


export default class WorkoutDBService {

  /*static allowedColumns = [
    "start_time",
    "uid",
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];

  static numericFields = [
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];*/

  static async getTrack(id, uid) {
    const result = await pool.query(
      `SELECT 
        id,
        sampleRateGPS, 
        ST_AsGeoJSON(geom)::json AS track 
        FROM workouts 
        WHERE id = $1 and uid = $2`,
      [id, uid]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    return result.rows[0];
  }


  static async getStream(id, uid) {
    const result = await pool.query(
      `SELECT stream FROM workouts WHERE id = $1 and uid = $2`,
      [id, uid]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    const stream = result.rows[0].stream;
    return stream;
  }

  static async getWorkout(id) {
    const result = await pool.query(
      `SELECT stream FROM workouts WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    const stream = result.rows[0].stream;

    const workoutObject = await Workout.fromCompressed(stream);

    return workoutObject;
  }

  static async getWorkouts(ids) {
    const result = await pool.query(
      `SELECT id, stream FROM workouts WHERE id = ANY($1::bigint[]);`,
      [ids]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    const workoutMap = new Map();

    for (const w of result.rows) {
      const workoutObject = await Workout.fromCompressed(w.stream);
      workoutMap.set(w.id, workoutObject);
    };

    return workoutMap;

  }


} // class

