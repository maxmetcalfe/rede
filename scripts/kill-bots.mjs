#!/usr/bin/env node
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const wranglerConfigPath = path.join(projectRoot, "wrangler.jsonc");
const BOT_CLASS = "BotDurableObject";

const stripJsonComments = (text) => {
  let inString = false;
  let stringChar = "";
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (!inString && char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }

    if ((char === `"` || char === "'") && text[i - 1] !== "\\") {
      if (inString && char === stringChar) {
        inString = false;
        stringChar = "";
      } else if (!inString) {
        inString = true;
        stringChar = char;
      }
    }

    result += char;
  }
  return result;
};

async function loadConfig() {
  const raw = await readFile(wranglerConfigPath, "utf8");
  const prefixMatch = raw.match(/^\s*(\/\*[\s\S]*?\*\/\s*)/);
  const prefix = prefixMatch ? prefixMatch[1] : "";
  const withoutPrefix = prefixMatch ? raw.slice(prefixMatch[0].length) : raw;
  const parsed = JSON.parse(stripJsonComments(withoutPrefix));
  return { config: parsed, prefix };
}

async function saveConfig(config, prefix) {
  const payload = `${prefix ?? ""}${JSON.stringify(config, null, 2)}\n`;
  await writeFile(wranglerConfigPath, payload);
}

const cloneConfig = (config) => JSON.parse(JSON.stringify(config));

const ensureArray = (config, key) => {
  if (!Array.isArray(config[key])) {
    config[key] = [];
  }
};

const createTag = (prefix) =>
  `${prefix}-${new Date()
    .toISOString()
    .replace(/[-:TZ]/g, "")
    .slice(0, 14)}`;

async function writeTempConfig(config) {
  const tempConfig = cloneConfig(config);
  if (tempConfig.main) {
    tempConfig.main = path.resolve(projectRoot, tempConfig.main);
  }
  const tempDir = await mkdtemp(path.join(tmpdir(), "kill-bots-"));
  const tempPath = path.join(tempDir, "wrangler.jsonc");
  await writeFile(tempPath, JSON.stringify(tempConfig, null, 2));
  return tempPath;
}

const spawnAsync = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });

async function appendDeleteMigration(config, prefix) {
  ensureArray(config, "migrations");
  const tag = createTag("bots-kill");
  config.migrations.push({
    tag,
    deleted_classes: [BOT_CLASS],
  });
  await saveConfig(config, prefix);
  return tag;
}

async function appendRecreateMigration(config, prefix) {
  ensureArray(config, "migrations");
  const tag = createTag("bots-reset");
  config.migrations.push({
    tag,
    new_sqlite_classes: [BOT_CLASS],
  });
  await saveConfig(config, prefix);
  return tag;
}

async function runKillSequence() {
  const { config, prefix } = await loadConfig();

  if (
    !config.durable_objects ||
    !Array.isArray(config.durable_objects.bindings) ||
    !config.durable_objects.bindings.some(
      (binding) => binding.class_name === BOT_CLASS,
    )
  ) {
    throw new Error(
      `Cannot find Durable Object binding for ${BOT_CLASS} in wrangler.jsonc`,
    );
  }

  console.log("Appending delete migration for BotDurableObject…");
  await appendDeleteMigration(config, prefix);

  const killConfig = cloneConfig(config);
  if (killConfig.durable_objects?.bindings) {
    killConfig.durable_objects.bindings =
      killConfig.durable_objects.bindings.filter(
        (binding) => binding.class_name !== BOT_CLASS,
      );
  }

  const tempConfigPath = await writeTempConfig(killConfig);
  console.log("Applying delete migration (removes all existing bots) …");
  await spawnAsync("npx", ["wrangler", "deploy", "--config", tempConfigPath], {
    cwd: projectRoot,
    env: process.env,
  });

  console.log(
    "Appending migration to recreate a fresh BotDurableObject class…",
  );
  await appendRecreateMigration(config, prefix);

  console.log(
    "Redeploying worker with an empty bot namespace (BOT_DEPLOY_TARGETS=[]) …",
  );
  await spawnAsync(
    "npx",
    [
      "wrangler",
      "deploy",
      "--config",
      wranglerConfigPath,
      "--var",
      "BOT_DEPLOY_TARGETS=[]",
    ],
    {
      cwd: projectRoot,
      env: process.env,
    },
  );

  console.log(
    "Done. All bot Durable Objects have been deleted and a fresh namespace is ready.",
  );
}

runKillSequence().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
