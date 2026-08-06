import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import { Zip, ZipPassThrough } from "fflate";

export default class StreamingZipFileWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.output = createWriteStream(filePath, { highWaterMark: 256 * 1024 });
    this.output.on("error", () => {});
    this.hash = createHash("sha256");
    this.sizeBytes = 0;
    this.writeChain = Promise.resolve();
    this.error = null;
    this.finished = false;
    this.zip = new Zip((error, chunk) => {
      if (error) {
        this.abort(error);
        return;
      }
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.hash.update(bytes);
      this.sizeBytes += bytes.byteLength;
      this.writeChain = this.writeChain.then(async () => {
        if (!this.output.write(bytes)) await once(this.output, "drain");
      });
    });
  }

  async add(name, bytes) {
    if (this.finished) throw new Error("ZIP writer is already closed.");
    if (this.error) throw this.error;
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    entry.push(source, true);
    await this.writeChain;
    if (this.error) throw this.error;
  }

  async finish() {
    if (this.finished) throw new Error("ZIP writer is already closed.");
    this.finished = true;
    this.zip.end();
    await this.writeChain;
    if (this.error) throw this.error;
    this.output.end();
    await finished(this.output);
    return { filePath: this.filePath, sizeBytes: this.sizeBytes, sha256: this.hash.digest("hex") };
  }

  abort(error = new Error("ZIP writing aborted.")) {
    if (this.error || (this.finished && this.output.closed)) return;
    this.finished = true;
    this.error = error;
    this.output.destroy(this.error);
  }
}
