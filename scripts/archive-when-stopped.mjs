#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const DEFAULT_BASE_URL =
  process.env.BOT_HEALTHCHECK_URL ?? "http://localhost:8787";
const DEFAULT_POLL_MS = 2000;

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
    if (arg === "--poll") {
      options.poll = argv[i + 1];
      i += 1;
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
    throw new Error(
      `Request failed ${response.status} ${response.statusText} for ${url}`,
    );
  }
  return response.text();
}

function parseNdjson(ndjson) {
  return ndjson
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findStopEvent(events) {
  return events.find(
    (event) =>
      event?.event === "conversation.stop" ||
      (event?.event === "brain.skip" &&
        event.payload?.reason === "conversation-expired"),
  );
}

async function pollUntilStop(baseUrl, pollMs) {
  let warned = false;
  while (true) {
    let ndjson;
    try {
      ndjson = await fetchText(`${baseUrl}/bots/events`);
    } catch (error) {
      if (!warned) {
        console.warn(
          `Watcher cannot reach ${baseUrl}/bots/events yet (${error.message}). Retrying…`,
        );
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    warned = false;
    const events = parseNdjson(ndjson);
    const stop = findStopEvent(events);
    if (stop) {
      return { ndjson, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function archiveTimeline({
  runId,
  baseUrl,
  outputDir,
  ndjson,
}) {
  const html = await fetchText(`${baseUrl}/bots/events/timeline`);
  await mkdir(outputDir, { recursive: true });
  const ndjsonPath = path.join(outputDir, `${runId}.ndjson`);
  const htmlPath = path.join(outputDir, `${runId}.html`);
  await writeFile(ndjsonPath, ndjson.endsWith("\n") ? ndjson : `${ndjson}\n`);
  await writeFile(htmlPath, html);
  return { ndjsonPath, htmlPath };
}

async function main() {
  const { runId: cliRunId, url, dir, poll } = parseArgs(
    process.argv.slice(2),
  );
  const runId = (cliRunId ?? process.env.RUN_ID ?? "").trim() || timestampId();
  const baseUrl = normalizeBase(url ?? DEFAULT_BASE_URL);
  const outputDir = path.join(projectRoot, dir ?? "runs");
  const pollMs = Number(poll ?? DEFAULT_POLL_MS);

  console.log(
    `Watching for conversation stop (runId="${runId}", poll=${pollMs}ms) against ${baseUrl} …`,
  );

  const { ndjson, stop } = await pollUntilStop(baseUrl, pollMs);
  console.log(
    `Detected stop event (${stop.event}) at ${stop.timestamp ?? "unknown time"}; archiving…`,
  );

  const { ndjsonPath, htmlPath } = await archiveTimeline({
    runId,
    baseUrl,
    outputDir,
    ndjson,
  });

  console.log(`Saved NDJSON to ${path.relative(projectRoot, ndjsonPath)}`);
  console.log(`Saved HTML to   ${path.relative(projectRoot, htmlPath)}`);
  console.log("Done.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
