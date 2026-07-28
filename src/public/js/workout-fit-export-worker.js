import { unzipSync, Zip, ZipDeflate } from "/vendor/fflate/browser.js";

function concatenate(chunks) {
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createFinalArchive() {
  const chunks = [];
  let resolveArchive;
  let rejectArchive;
  const promise = new Promise((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      rejectArchive(error);
      return;
    }
    chunks.push(chunk);
    if (final) {
      resolveArchive(concatenate(chunks));
    }
  });

  return {
    add(fileName, bytes) {
      const entry = new ZipDeflate(fileName, { level: 1 });
      zip.add(entry);
      entry.push(bytes, true);
    },
    finish() {
      zip.end();
      return promise;
    }
  };
}

async function convertArchive(sourceBuffer) {
  const startedAt = performance.now();
  const unzipStartedAt = performance.now();
  const entries = Object.entries(unzipSync(new Uint8Array(sourceBuffer)))
    .filter(([fileName]) => fileName.toLowerCase().endsWith(".wopn"));
  const unzipMs = performance.now() - unzipStartedAt;
  const total = entries.length;
  if (total === 0) {
    throw new Error("Der Export enthält keine Workouts.");
  }

  const workerCount = Math.max(
    1,
    Math.min(6, total, Number(self.navigator?.hardwareConcurrency || 4) - 1)
  );
  const archive = createFinalArchive();
  let nextIndex = 0;
  let completed = 0;

  await new Promise((resolve, reject) => {
    let stopped = false;
    const workers = [];

    const stopWorkers = () => {
      for (const worker of workers) {
        worker.terminate();
      }
    };

    const dispatch = (worker) => {
      if (stopped) {
        return;
      }
      if (nextIndex >= entries.length) {
        if (completed >= total) {
          stopped = true;
          stopWorkers();
          resolve();
        }
        return;
      }

      const jobId = nextIndex;
      const [, sourceBytes] = entries[nextIndex];
      entries[nextIndex] = null;
      nextIndex += 1;
      const payloadBytes = sourceBytes.slice();
      worker.postMessage({ jobId, payloadBytes }, [payloadBytes.buffer]);
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker("/js/workout-fit-entry-worker.js", { type: "module" });
      workers.push(worker);
      worker.addEventListener("message", (event) => {
        if (event.data?.type === "error") {
          stopped = true;
          stopWorkers();
          reject(new Error(event.data.message || "FIT-Konvertierung fehlgeschlagen."));
          return;
        }
        if (event.data?.type !== "result") {
          return;
        }

        archive.add(event.data.fileName, event.data.fitBytes);
        completed += 1;
        self.postMessage({ type: "progress", completed, total });
        dispatch(worker);
      });
      worker.addEventListener("error", (error) => {
        if (!stopped) {
          stopped = true;
          stopWorkers();
          reject(error);
        }
      });
      dispatch(worker);
    }
  });

  const archiveBytes = await archive.finish();
  return {
    archiveBytes,
    profile: {
      workoutCount: total,
      workerCount,
      unzipMs,
      convertAndZipMs: performance.now() - startedAt - unzipMs,
      totalMs: performance.now() - startedAt
    }
  };
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") {
    return;
  }
  try {
    const result = await convertArchive(event.data.sourceBuffer);
    self.postMessage({
      type: "complete",
      archiveBytes: result.archiveBytes,
      profile: result.profile
    }, [result.archiveBytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
});
