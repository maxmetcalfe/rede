#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function timestampId() {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run" || arg === "--runId") {
      opts.runId = argv[i + 1];
      i += 1;
    } else if (arg === "--url") {
      opts.url = argv[i + 1];
      i += 1;
    } else if (arg === "--poll") {
      opts.poll = argv[i + 1];
      i += 1;
    } else if (arg === "--dir") {
      opts.dir = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function spawnProc(cmd, args, extraEnv = {}) {
  return spawn(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

async function main() {
  const { runId: cliRunId, url, poll, dir } = parseArgs(process.argv.slice(2));
  const runId = (cliRunId ?? process.env.RUN_ID ?? "").trim() || timestampId();
  const archiveArgs = ["run", "archive:auto", "--", "--run", runId];
  if (url) archiveArgs.push("--url", url);
  if (poll) archiveArgs.push("--poll", poll);
  if (dir) archiveArgs.push("--dir", dir);

  console.log(`Starting wrangler dev with RUN_ID="${runId}" and auto-archive watcher…`);

  const wrangler = spawnProc("npx", ["wrangler", "dev"], { RUN_ID: runId });
  const watcher = spawnProc("npm", archiveArgs, { RUN_ID: runId });

  const stopAll = (code) => {
    if (!wrangler.killed) {
      wrangler.kill("SIGINT");
    }
    if (!watcher.killed) {
      watcher.kill("SIGINT");
    }
    process.exitCode = code ?? 0;
  };

  wrangler.on("exit", (code) => {
    console.log(`wrangler dev exited with code ${code ?? 0}, stopping watcher…`);
    stopAll(code);
  });
  watcher.on("exit", (code) => {
    console.log(`archive watcher exited with code ${code ?? 0}, keeping wrangler dev running. Press Ctrl+C to stop.`);
  });

  process.on("SIGINT", () => stopAll(0));
  process.on("SIGTERM", () => stopAll(0));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
