import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const processes = [
  ["app", new URL("../index.js", import.meta.url)],
  ["worker", new URL("../workers/import-worker.js", import.meta.url)],
  ["backup", new URL("../workers/postgres-backup-ops-worker.js", import.meta.url)]
];

export function startAll(entries = processes) {
  const children = new Set();
  let stopping = false;
  let killTimer;

  function stop(code, signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) child.kill(signal);
    killTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 10_000);
    killTimer.unref();
  }

  const onInterrupt = () => stop(130, "SIGINT");
  const onTerminate = () => stop(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  for (const [name, entry] of entries) {
    const child = spawn(process.execPath, [fileURLToPath(entry)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    children.add(child);
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      createInterface({ input: stream }).on("line", (line) => output.write(`[${name}] ${line}\n`));
    }
    child.on("error", (error) => {
      console.error(`[${name}] Start fehlgeschlagen: ${error.message}`);
      stop(1);
    });
    child.on("exit", (code, signal) => {
      console.log(`[${name}] Beendet (${signal || code}).`);
      stop(code || 1);
    });
    child.on("close", () => {
      children.delete(child);
      if (children.size === 0) {
        clearTimeout(killTimer);
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      }
    });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startAll();
