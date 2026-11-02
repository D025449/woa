import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const processes = [
  ["app", new URL("../index.js", import.meta.url)],
  ["worker", new URL("../workers/import-worker.js", import.meta.url)],
  ["backup", new URL("../workers/postgres-backup-ops-worker.js", import.meta.url)]
];

export async function waitForApp(port, signal) {
  const deadline = AbortSignal.timeout(30_000);
  const combined = AbortSignal.any([signal, deadline]);
  while (!combined.aborted) {
    try {
      const response = await fetch(`http://localhost:${port}`, {
        redirect: "manual",
        signal: AbortSignal.any([combined, AbortSignal.timeout(1000)])
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      combined.throwIfAborted();
    }
    await delay(250, undefined, { signal: combined });
  }
  combined.throwIfAborted();
}

export function startAll(entries = processes, {
  ngrokUrl = "",
  environment = process.env,
  port = environment.PORT || 3000,
  spawnProcess = spawn,
  waitForReady = waitForApp
} = {}) {
  const childEnvironment = { ...environment };
  if ((environment.NODE_ENV || "development") === "development") {
    const appBaseUrl = ngrokUrl ? new URL(ngrokUrl).origin : `http://localhost:${port}`;
    childEnvironment.APP_BASE_URL = appBaseUrl;
    childEnvironment.COGNITO_REDIRECT_URI = `${appBaseUrl}/auth/callback`;
    childEnvironment.PORT = String(port);
  }
  const children = new Set();
  const readiness = new AbortController();
  let stopping = false;
  let killTimer;

  function stop(code, signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    readiness.abort();
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

  function launch(name, command, args, optional = false) {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment
    });
    children.add(child);
    for (const { stream, output } of [
      { stream: child.stdout, output: process.stdout },
      { stream: child.stderr, output: process.stderr }
    ]) {
      if (!stream) continue;
      createInterface({ input: stream }).on("line", (line) => output.write(`[${name}] ${line}\n`));
    }
    child.on("error", (error) => {
      console.error(`[${name}] Start fehlgeschlagen: ${error.message}`);
      if (!optional) stop(1);
    });
    child.on("exit", (code, signal) => {
      console.log(`[${name}] Beendet (${signal || code}).`);
      if (!optional) stop(code || 1);
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

  for (const [name, entry] of entries) {
    launch(name, process.execPath, [fileURLToPath(entry)]);
  }

  if (ngrokUrl) {
    void waitForReady(port, readiness.signal).then(() => {
      if (!stopping) launch("ngrok", "ngrok", ["http", String(port), "--url", ngrokUrl], true);
    }).catch(() => {
      if (!stopping) console.error("[ngrok] App nicht erreichbar; lokale Dienste laufen ohne Tunnel weiter.");
    });
  }

  return stop;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ngrokUrl = process.argv[2] === "--ngrok" ? process.argv[3] : undefined;
  dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}`, quiet: true });
  startAll(processes, { ngrokUrl });
}
