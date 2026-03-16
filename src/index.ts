import {
	BotDurableObject,
	BotRegistry,
	BotDefinition,
	BotDeploymentPayload,
	StoredBot,
	jsonResponse,
} from "./bot";
import { clearEventLog, getEventLog, logEvent } from "./logger";

export { BotDurableObject };

function ensureBotDefinition(
	name: string,
	registry: BotRegistry,
): BotDefinition | Response {
	const definition = registry.getBotDefinition(name);
	if (!definition) {
		return new Response(`Bot "${name}" is not declared in bots.json.`, {
			status: 404,
		});
	}
	return definition;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const [, root = "", maybeName = "", maybeAction = ""] = url.pathname
			.split("/")
			.map((segment) => segment.trim())
			.map(decodeURIComponent);

		const registry = new BotRegistry(env);
		scheduleAutoDeployment(registry, env, url.origin, ctx);

		if (!root || root.length === 0) {
			return jsonResponse({
				message:
					"Send requests to /bots to list bots or /bots/:name to interact with a specific bot.",
			});
		}

		if (root !== "bots") {
			return new Response("Not Found", { status: 404 });
		}

		if (!maybeName) {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const bots = registry.getActiveBots().map((bot) =>
				registry.sanitize({
					...bot,
					createdAt: bot.createdAt ?? "not-set",
				}),
			);
			return jsonResponse(bots);
		}

		if (maybeName === "events") {
			if (maybeAction === "reset") {
				if (request.method !== "POST") {
					return new Response("Method Not Allowed", { status: 405 });
				}
				clearEventLog();
				return jsonResponse({ message: "Event log cleared." });
			}
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const events = getEventLog();
			if (maybeAction === "timeline") {
				return renderTimeline(events);
			}
			if (maybeAction && maybeAction.length > 0) {
				return new Response("Not Found", { status: 404 });
			}
			const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
			return new Response(body, {
				headers: {
					"content-type": "application/x-ndjson",
					"cache-control": "no-store",
				},
			});
		}

		if (maybeName === "reset") {
			if (request.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const resetBots = registry.getActiveBots();
			await Promise.all(
				resetBots.map(async (bot) => {
					const resetStub = env.BOTS.getByName(bot.name);
					await resetStub.resetState();
				}),
			);
			clearEventLog();
			autoDeployPromise = undefined;
			return jsonResponse({
				message: "All active bot state cleared.",
				bots: resetBots.map((bot) => bot.name),
			});
		}

		const definitionOrResponse = ensureBotDefinition(maybeName, registry);
	if (definitionOrResponse instanceof Response) {
			return definitionOrResponse;
		}
		const targetBot = definitionOrResponse;
		const stub = env.BOTS.getByName(targetBot.name);

			if (maybeAction === "deploy") {
			if (request.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const bot = await deployBot(
				stub,
				targetBot,
				registry,
				env,
				url.origin,
			);
			return jsonResponse(
				{
					message: `Bot "${targetBot.name}" deployed.`,
					bot: registry.sanitize(bot),
				},
				{ status: 201 },
			);
		}

			if (maybeAction === "message") {
				if (request.method !== "POST") {
					return new Response("Method Not Allowed", { status: 405 });
				}
				let body: { to?: string; content?: string };
			try {
				body = await request.json();
			} catch {
				return new Response("Invalid JSON payload.", { status: 400 });
			}
			const to = typeof body.to === "string" ? body.to.trim() : "";
			const content =
				typeof body.content === "string" ? body.content.trim() : "";
				if (!to || !content) {
					return new Response(
						'Both "to" and "content" fields are required.',
						{ status: 400 },
					);
				}
				const recipientOrResponse = ensureBotDefinition(to, registry);
				if (recipientOrResponse instanceof Response) {
					return recipientOrResponse;
				}
			const recipient = recipientOrResponse;
			const timestamp = await sendMessageBetweenBots(
				targetBot,
				recipient,
				content,
				registry,
				env,
				url.origin,
			);
				return jsonResponse({
					message: `Bot "${targetBot.name}" sent a message to "${recipient.name}".`,
					timestamp,
				});
			}

			if (maybeAction === "reset") {
				if (request.method !== "POST") {
					return new Response("Method Not Allowed", { status: 405 });
				}
				await stub.resetState();
				return jsonResponse({
					message: `Bot "${targetBot.name}" state cleared.`,
				});
			}

		if (maybeAction === "health") {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			try {
				let status = await stub.healthcheck();
				const expectedBots =
					buildDeploymentPayload(targetBot, registry, url.origin).peers
						.length;
				if (status.knownBots !== expectedBots) {
					await deployBot(
						stub,
						targetBot,
						registry,
						env,
						url.origin,
					);
					status = await stub.healthcheck();
				}
				return jsonResponse({
					message: `Bot "${targetBot.name}" responded to healthcheck.`,
					health: status,
				});
			} catch (error) {
				return jsonResponse(
					{
						message: `Bot "${targetBot.name}" failed healthcheck.`,
						error:
							error instanceof Error ? error.message : String(error ?? "unknown error"),
					},
					{ status: 503 },
				);
			}
		}

		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		try {
			const profile = await stub.getProfile();
			return jsonResponse(registry.sanitize(profile));
		} catch {
			const deployed = await deployBot(
				stub,
				targetBot,
				registry,
				env,
				url.origin,
			);
			return jsonResponse(
				{
					message: `Bot "${targetBot.name}" was not deployed and has been initialized now.`,
					bot: registry.sanitize(deployed),
				},
				{ status: 201 },
			);
		}
	},
} satisfies ExportedHandler<Env>;

function buildDeploymentPayload(
	targetBot: BotDefinition,
	registry: BotRegistry,
	origin: string,
): BotDeploymentPayload {
	const peers = registry.getActiveBots().map((bot) => ({
		name: bot.name,
		botUrl: new URL(`/bots/${encodeURIComponent(bot.name)}`, origin).toString(),
		prompt: bot.prompt,
	}));
	return {
		bot: targetBot,
		peers,
	};
}

async function deployBot(
	stub: DurableObjectStub<BotDurableObject>,
	targetBot: BotDefinition,
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<StoredBot> {
	const payload = buildDeploymentPayload(targetBot, registry, origin);
	const deployed = await initializeBotState(stub, payload);
	await new Promise((resolve) => setTimeout(resolve, 2000));
	await announcePresence(targetBot, registry, env, origin);
	logEvent("deploy.complete", {
		bot: targetBot.name,
		knownBots: payload.peers.length,
	});
	return deployed;
}

async function initializeBotState(
	stub: DurableObjectStub<BotDurableObject>,
	payload: BotDeploymentPayload,
): Promise<StoredBot> {
	return stub.deploy(payload);
}

async function ensureBotState(
	stub: DurableObjectStub<BotDurableObject>,
	targetBot: BotDefinition,
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<void> {
	try {
		await stub.getProfile();
	} catch {
		await initializeBotState(
			stub,
			buildDeploymentPayload(targetBot, registry, origin),
		);
	}
}

async function announcePresence(
	targetBot: BotDefinition,
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<void> {
	if (isFlagEnabled(readEnvValue(env, "DISABLE_AUTO_ANNOUNCE"))) {
		logEvent("announce.skip", {
			bot: targetBot.name,
			reason: "disabled",
		});
		return;
	}
	const peers = registry
		.getActiveBots()
		.filter((bot) => bot.name !== targetBot.name);
	logEvent("announce.start", {
		bot: targetBot.name,
		peerCount: peers.length,
	});
	await Promise.all(
		peers.map(async (peer) => {
			try {
				await sendMessageBetweenBots(
					targetBot,
					peer,
					"I'm here",
					registry,
						env,
						origin,
					);
					logEvent("announce.sent", {
						from: targetBot.name,
						to: peer.name,
					});
				} catch (error) {
					logEvent("announce.error", {
						from: targetBot.name,
						to: peer.name,
						error:
							error instanceof Error ? error.message : String(error ?? "unknown error"),
					});
				}
			}),
	);
}

async function sendMessageBetweenBots(
	from: BotDefinition,
	to: BotDefinition,
	content: string,
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<string> {
	const senderStub = env.BOTS.getByName(from.name);
	await ensureBotState(senderStub, from, registry, env, origin);
	const recipientStub = env.BOTS.getByName(to.name);
	await ensureBotState(recipientStub, to, registry, env, origin);
	const timestamp = new Date().toISOString();
	await recipientStub.receiveMessage({
		botId: from.name,
		content,
		timestamp,
	});
	logEvent("message.send", {
		from: from.name,
		to: to.name,
		content,
		timestamp,
	});
	return timestamp;
}

let autoDeployPromise: Promise<void> | undefined;

function scheduleAutoDeployment(
	registry: BotRegistry,
	env: Env,
	origin: string,
	ctx: ExecutionContext,
): void {
	if (isFlagEnabled(readEnvValue(env, "DISABLE_AUTO_DEPLOY"))) {
		return;
	}
	const bots = registry.getActiveBots();
	if (bots.length === 0) {
		return;
	}
	if (!autoDeployPromise) {
		autoDeployPromise = autoDeployAllBots(bots, registry, env, origin).catch(
			(error) => {
				logEvent("deploy.auto.error", {
					error: error instanceof Error ? error.message : String(error ?? "unknown error"),
				});
				autoDeployPromise = undefined;
				throw error;
			},
		);
	}
	ctx.waitUntil(autoDeployPromise.catch(() => {}));
}

async function autoDeployAllBots(
	bots: BotDefinition[],
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<void> {
	logEvent("deploy.auto.start", { bots: bots.map((bot) => bot.name) });
	const failures: string[] = [];
	for (const bot of bots) {
		const stub = env.BOTS.getByName(bot.name);
		try {
			await deployBot(stub, bot, registry, env, origin);
		} catch (error) {
			failures.push(bot.name);
			logEvent("deploy.auto.bot_error", {
				bot: bot.name,
				error: error instanceof Error ? error.message : String(error ?? "unknown error"),
			});
		}
	}
	if (failures.length > 0) {
		logEvent("deploy.auto.complete", {
			status: "partial",
			deployed: bots.length - failures.length,
			failed: failures,
		});
		throw new Error(`Failed to auto deploy bots: ${failures.join(", ")}`);
	}
	logEvent("deploy.auto.complete", { status: "ok", deployed: bots.length });
}

function isFlagEnabled(value?: string): boolean {
	if (typeof value !== "string") {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	);
}

function readEnvValue(
	env: Env,
	name: keyof Pick<Env, "BOT_DEPLOY_TARGETS" | "DISABLE_AUTO_ANNOUNCE" | "DISABLE_AUTO_DEPLOY">,
): string | undefined {
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(`${name}=`)) {
			continue;
		}
		const inline = key.slice(name.length + 1).trim();
		if (inline.length > 0) {
			return inline;
		}
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	const direct = env[name];
	return typeof direct === "string" && direct.trim().length > 0
		? direct.trim()
		: undefined;
}

function renderTimeline(events: ReturnType<typeof getEventLog>): Response {
	const items =
		events.length > 0
			? events
					.map((event) => {
						const botName = extractBotName(event.payload);
						const participants = buildParticipantText(event.payload);
						const content = extractContent(event.payload);
						const payload =
							event.payload && Object.keys(event.payload).length > 0
								? escapeHtml(JSON.stringify(event.payload, null, 2))
								: "";
						return `
          <li class="event-row">
            <div class="event-meta">
              <span class="pill event-pill">${escapeHtml(event.event)}</span>
              ${
								botName
									? `<span class="pill bot-pill">${escapeHtml(botName)}</span>`
									: ""
							}
              <time>${escapeHtml(event.timestamp)}</time>
              ${
								participants
									? `<span class="participants">${escapeHtml(participants)}</span>`
									: ""
							}
              ${
								content
									? `<span class="content-preview">${escapeHtml(truncate(content, 140))}</span>`
									: ""
							}
            </div>
            ${
							payload
								? `<pre class="payload">${payload}</pre>`
								: '<pre class="payload muted">{}</pre>'
						}
          </li>
        `;
					})
					.join("")
			: '<li class="empty-row">No events recorded yet.</li>';
	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bot Timeline</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Space Grotesk", "DM Sans", "Segoe UI", system-ui, sans-serif;
      }
      body {
        margin: 0;
        padding: 16px;
        background: #ffffff;
        color: #0f172a;
        font-family: "Space Grotesk", "DM Sans", "Segoe UI", system-ui, sans-serif;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 20px;
      }
      p {
        margin: 0 0 12px;
        color: #334155;
      }
      a {
        color: #2563eb;
      }
      .timeline-shell {
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        padding: 12px;
        overflow: auto;
        max-height: 80vh;
      }
      .timeline-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .event-row {
        padding: 10px;
        border: 1px solid #e2e8f0;
        background: #ffffff;
      }
      .event-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        font-size: 13px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #94a3b8;
        background: #e2e8f0;
        color: #0f172a;
      }
      .bot-pill {
        background: #eef2ff;
        color: #312e81;
        border-color: #c7d2fe;
      }
      time {
        color: #475569;
        font-size: 12px;
      }
      .participants {
        color: #0f172a;
        font-weight: 600;
      }
      .content-preview {
        color: #475569;
      }
      .payload {
        margin: 8px 0 0;
        font-size: 12px;
        background: #0f172a;
        color: #e2e8f0;
        padding: 8px;
        overflow: auto;
        max-height: 200px;
        border: 1px solid #0f172a;
      }
      .payload.muted {
        background: #f8fafc;
        color: #94a3b8;
        border: 1px dashed #e2e8f0;
      }
      .empty-row {
        padding: 12px;
        border: 1px dashed #e2e8f0;
        color: #475569;
        background: #ffffff;
      }
      @media (max-width: 768px) {
        body {
          padding: 12px;
        }
      }
    </style>
  </head>
  <body>
    <h1>Bot Timeline</h1>
    <p>Showing the latest ${events.length} events. <a href="/bots/events">Download NDJSON</a></p>
    <div class="timeline-shell">
      <ul class="timeline-list">${items}</ul>
    </div>
  </body>
</html>`;
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function extractBotName(payload?: Record<string, unknown>): string | undefined {
	if (!payload) {
		return undefined;
	}
	const candidate = payload.bot ?? payload.from;
	return typeof candidate === "string" ? candidate : undefined;
}

function colorForEvent(event: string): string {
	if (event.startsWith("message.")) {
		return "#2563eb";
	}
	if (event.startsWith("brain.")) {
		return "#f97316";
	}
	if (event.startsWith("deploy.")) {
		return "#7c3aed";
	}
	if (event.startsWith("announce")) {
		return "#0ea5e9";
	}
	if (event.startsWith("health")) {
		return "#16a34a";
	}
	return "#6b7280";
}

function colorForBot(bot: string): string {
	const palette = [
		"#4ac1ff",
		"#f472b6",
		"#a78bfa",
		"#22d3ee",
		"#fbbf24",
		"#10b981",
		"#fb7185",
	];
	let hash = 0;
	for (let i = 0; i < bot.length; i += 1) {
		hash = (hash << 5) - hash + bot.charCodeAt(i);
		hash |= 0;
	}
	const index = Math.abs(hash) % palette.length;
	return palette[index];
}

function buildParticipantText(payload?: Record<string, unknown>): string {
	if (!payload) {
		return "";
	}
	const from = typeof payload.from === "string" ? payload.from : undefined;
	const to = typeof payload.to === "string" ? payload.to : undefined;
	if (from && to) {
		return `${from} → ${to}`;
	}
	if (from) {
		return from;
	}
	if (to) {
		return `→ ${to}`;
	}
	const bot = typeof payload.bot === "string" ? payload.bot : undefined;
	return bot ?? "";
}

function extractContent(payload?: Record<string, unknown>): string {
	if (!payload) {
		return "";
	}
	if (typeof payload.content === "string") {
		return payload.content;
	}
	if (typeof payload.message === "string") {
		return payload.message;
	}
	return "";
}

function truncate(text: string, length = 160): string {
	if (text.length <= length) {
		return text;
	}
	return `${text.slice(0, length - 1)}…`;
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
