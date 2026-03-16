#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const DEFAULT_BASE_URL =
  process.env.BOT_HEALTHCHECK_URL ?? "http://localhost:8787";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run" || arg === "--runId") {
      options.runId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--url") {
      options.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--dir") {
      options.dir = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return options;
}

function timestampId() {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function normalizeBase(url) {
  try {
    const parsed = new URL(url);
    return parsed.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(`Invalid base URL: ${url} (${error.message})`);
  }
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

async function main() {
  const { runId: cliRunId, url, dir } = parseArgs(process.argv.slice(2));
  const runId = (cliRunId ?? process.env.RUN_ID ?? "").trim() || timestampId();
  const base = normalizeBase(url ?? DEFAULT_BASE_URL);
  const outputDir = path.join(projectRoot, dir ?? "runs");

  console.log(`Archiving timeline for runId="${runId}" from ${base} …`);

  const [ndjson, html] = await Promise.all([
    fetchText(`${base}/bots/events`),
    fetchText(`${base}/bots/events/timeline`),
  ]);

  await mkdir(outputDir, { recursive: true });

  const ndjsonPath = path.join(outputDir, `${runId}.ndjson`);
  const htmlPath = path.join(outputDir, `${runId}.html`);

  await writeFile(ndjsonPath, ndjson.endsWith("\n") ? ndjson : `${ndjson}\n`);
  await writeFile(htmlPath, html);

  console.log(`Saved NDJSON to ${path.relative(projectRoot, ndjsonPath)}`);
  console.log(`Saved HTML to   ${path.relative(projectRoot, htmlPath)}`);
  console.log("Done.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
