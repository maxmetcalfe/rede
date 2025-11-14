#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const botsFile = path.join(projectRoot, "bots.json");

async function loadBots() {
	const raw = await readFile(botsFile, "utf-8");
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("bots.json must contain at least one bot definition.");
	}
	return parsed;
}

function parseArgs(argv) {
	const names = [];
	let url;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--bot" || arg === "-b") {
			const name = argv[i + 1];
			if (!name) {
				throw new Error("Missing value for --bot option.");
			}
			names.push(name);
			i += 1;
			continue;
		}
		if (arg === "--url" || arg === "--healthcheck-url") {
			const provided = argv[i + 1];
			if (!provided) {
				throw new Error("Missing value for --url option.");
			}
			url = provided;
			i += 1;
		}
	}
	return { names, url };
}

async function run() {
	const bots = await loadBots();
	const { names: requestedNames, url } = parseArgs(process.argv.slice(2));

	let selected = bots;
	if (requestedNames.length > 0) {
		selected = bots.filter((bot) => requestedNames.includes(bot.name));
		const missing = requestedNames.filter(
			(name) => !selected.some((bot) => bot.name === name),
		);
		if (missing.length > 0) {
			throw new Error(
				`Cannot deploy unknown bot${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
			);
		}
	}

	const names = selected.map((bot) => bot.name);
	const payload = JSON.stringify(names);
	const baseUrl = url ?? process.env.BOT_HEALTHCHECK_URL;
	if (!baseUrl) {
		throw new Error(
			"Healthcheck URL missing. Pass --url https://worker.example.com or set BOT_HEALTHCHECK_URL.",
		);
	}

	console.log(
		`Deploying worker with the following bots enabled: ${names.join(", ")}`,
	);

	await spawnAsync("npx", ["wrangler", "deploy", "--var", `BOT_DEPLOY_TARGETS=${payload}`], {
		cwd: projectRoot,
		env: process.env,
	});

	await ensureBotsDeployed(baseUrl, names);
	await waitForHealthchecks(baseUrl, names);
}

function spawnAsync(command, args, options) {
	return new Promise((resolve, reject) => {
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
}

async function waitForHealthchecks(baseUrl, names) {
	console.log(
		`Waiting for healthchecks from ${names.length} bot${names.length === 1 ? "" : "s"} via ${baseUrl}`,
	);
	for (const name of names) {
		await pollHealthcheck(baseUrl, name);
	}
}

async function ensureBotsDeployed(baseUrl, names) {
	console.log("Deploying Durable Objects via API...");
	for (const name of names) {
		const url = new URL(`/bots/${encodeURIComponent(name)}/deploy`, baseUrl).toString();
		const response = await fetch(url, { method: "POST" });
		if (!response.ok) {
			const body = await safeText(response);
			throw new Error(
				`Failed to deploy bot ${name}: ${response.status} ${response.statusText} ${body}`,
			);
		}
		console.log(`• ${name} deployed`);
	}
}

async function pollHealthcheck(baseUrl, name, {
	retries = 10,
	delayMs = 2000,
} = {}) {
	const url = new URL(`/bots/${encodeURIComponent(name)}/health`, baseUrl).toString();
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Status ${response.status}`);
			}
			console.log(`✓ ${name} healthy (attempt ${attempt})`);
			return;
		} catch (error) {
			if (attempt === retries) {
				throw new Error(
					`Bot ${name} failed healthcheck after ${retries} attempts: ${error instanceof Error ? error.message : error}`,
				);
			}
		}
		await sleep(delayMs);
	}
}

async function safeText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

run().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
