import fs from "fs";
import dotenv from "dotenv";
import Workout from "../shared/Workout.js";

function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const candidates = [`.env.${nodeEnv}`, ".env"];

  for (const path of candidates) {
    if (fs.existsSync(path)) {
      dotenv.config({ path, override: false });
      break;
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    limit: null,
    userId: null,
    commit: false,
    batchSize: 200
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      out.limit = Math.max(1, Number.parseInt(args[i + 1], 10) || 0);
      i += 1;
    } else if (arg === "--user" && args[i + 1]) {
      out.userId = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if (arg === "--commit") {
      out.commit = true;
    } else if (arg === "--batch-size" && args[i + 1]) {
      out.batchSize = Math.max(1, Number.parseInt(args[i + 1], 10) || out.batchSize);
      i += 1;
    }
  }

  return out;
}

function buildBatchQuery({ userId, batchSize, lastSeenId }) {
  const params = [];
  const where = [];

  params.push(lastSeenId);
  where.push(`id > $${params.length}`);

  if (Number.isInteger(userId) && userId > 0) {
    params.push(userId);
    where.push(`uid = $${params.length}`);
  }

  let sql = `
    SELECT id, uid, stream
    FROM workouts
  `;

  sql += ` WHERE ${where.join(" AND ")} `;
  sql += " ORDER BY id ASC ";
  params.push(batchSize);
  sql += ` LIMIT $${params.length} `;

  return { sql, params };
}

async function run() {
  loadEnv();
  const options = parseArgs();
  const { default: pool } = await import("../services/database.js");

  const summary = {
    scanned: 0,
    migrated: 0,
    alreadyAbsolute: 0,
    failed: 0,
    oldCompressedBytes: 0,
    newCompressedBytes: 0
  };

  try {
    console.log(`[migrate] mode=${options.commit ? "COMMIT" : "DRY-RUN"} batchSize=${options.batchSize} limit=${options.limit ?? "none"} user=${options.userId ?? "all"}`);

    let lastSeenId = 0;
    let remaining = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;

    while (true) {
      if (remaining !== null && remaining <= 0) {
        break;
      }

      const thisBatchSize = remaining === null
        ? options.batchSize
        : Math.min(options.batchSize, remaining);

      const { sql, params } = buildBatchQuery({
        userId: options.userId,
        batchSize: thisBatchSize,
        lastSeenId
      });
      const result = await pool.query(sql, params);

      if (result.rowCount === 0) {
        if (summary.scanned === 0) {
          console.log("No workouts found.");
        }
        break;
      }

      for (const row of result.rows) {
        lastSeenId = row.id;
        if (remaining !== null) {
          remaining -= 1;
        }
        summary.scanned += 1;

        try {
        const raw = await Workout.decompress(row.stream);
        const version = Workout.readFormatVersion(raw);

        if (version === 2) {
          summary.alreadyAbsolute += 1;
          continue;
        }

        const workout = Workout.fromBuffer(raw);
        const absBuffer = workout.toAbsoluteBuffer();
        const compressedAbsolute = await Workout.compress(absBuffer);

        const oldSize = row.stream.byteLength ?? row.stream.length ?? 0;
        const newSize = compressedAbsolute.byteLength ?? compressedAbsolute.length ?? 0;

        summary.migrated += 1;
        summary.oldCompressedBytes += oldSize;
        summary.newCompressedBytes += newSize;

        if (options.commit) {
          await pool.query(
            `UPDATE workouts SET stream = $1 WHERE id = $2`,
            [compressedAbsolute, row.id]
          );
        }

        console.log("[migrate] workout", {
          id: row.id,
          uid: row.uid,
          oldCompressedBytes: oldSize,
          newCompressedBytes: newSize,
          savedBytes: oldSize - newSize
        });
        } catch (err) {
          summary.failed += 1;
          console.error("[migrate] failed", {
            id: row.id,
            uid: row.uid,
            error: err.message
          });
        }
      }
    }

    const savedBytes = summary.oldCompressedBytes - summary.newCompressedBytes;
    const ratio = summary.oldCompressedBytes > 0
      ? summary.newCompressedBytes / summary.oldCompressedBytes
      : 1;

    console.log("[migrate] summary", {
      mode: options.commit ? "COMMIT" : "DRY-RUN",
      ...summary,
      savedBytes,
      compressionRatioAfterVsBefore: Number(ratio.toFixed(6))
    });
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Workout stream migration failed:", err);
  process.exit(1);
});
