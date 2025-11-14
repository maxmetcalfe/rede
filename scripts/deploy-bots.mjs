#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--bot" || arg === "-b") {
			const name = argv[i + 1];
			if (!name) {
				throw new Error("Missing value for --bot option.");
			}
			names.push(name);
			i += 1;
		}
	}
	return names;
}

async function run() {
	const bots = await loadBots();
	const requestedNames = parseArgs(process.argv.slice(2));

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

	console.log(
		`Deploying worker with the following bots enabled: ${names.join(", ")}`,
	);

	await spawnAsync("npx", ["wrangler", "deploy", "--var", `BOT_DEPLOY_TARGETS=${payload}`], {
		cwd: projectRoot,
		env: process.env,
	});
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

run().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
