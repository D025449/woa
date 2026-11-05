import { Worker } from "node:worker_threads";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";

export class LocalThumbnailMapClient {
  constructor({ workerFactory = (config) => new Worker(new URL("../workers/local-thumbnail-map-worker.js", import.meta.url),
    { workerData: config }), maxPending = 8, timeoutMs = 30000 } = {}) {
    this.workerFactory = workerFactory;
    this.maxPending = maxPending;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.active = null;
    this.queue = [];
    this.nextId = 0;
  }

  render(example, config = getLocalThumbnailMapConfig()) {
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxPending) return Promise.reject(new Error("local-map-busy"));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.nextId, example, config, resolve, reject, timer: null };
      job.timer = setTimeout(() => {
        if (this.active === job) this.reset(new Error("local-map-timeout"));
        else { this.queue = this.queue.filter(entry => entry !== job); reject(new Error("local-map-timeout")); }
      }, this.timeoutMs);
      this.queue.push(job);
      this.drain();
    });
  }

  drain() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    try {
      if (!this.worker) {
        const worker = this.workerFactory(job.config);
        this.worker = worker;
        worker.on("message", (message) => {
          if (this.worker !== worker || this.active?.id !== message.id) return;
          const current = this.active;
          this.active = null;
          clearTimeout(current.timer);
          if (message.error) current.reject(new Error(message.error));
          else current.resolve(message.result);
          if (!this.queue.length) worker.unref();
          this.drain();
        });
        worker.on("error", () => { if (this.worker === worker) this.reset(new Error("local-map-worker-error")); });
        worker.on("exit", () => { if (this.worker === worker) this.reset(new Error("local-map-worker-exit")); });
      }
      this.worker.ref();
      this.worker.postMessage({ id: job.id, example: job.example });
    } catch { this.reset(new Error("local-map-worker-error")); }
  }

  reset(error) {
    const worker = this.worker;
    this.worker = null;
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    for (const job of jobs) { clearTimeout(job.timer); job.reject(error); }
    if (worker) void worker.terminate();
  }

  close() {
    this.reset(new Error("local-map-closed"));
  }
}

export default new LocalThumbnailMapClient();