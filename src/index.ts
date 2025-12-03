import type {
	DurableObjectStub,
	ExecutionContext,
} from "cloudflare:workers";
import {
	BotDurableObject,
	BotRegistry,
	BotDefinition,
	BotDeploymentPayload,
	StoredBot,
	jsonResponse,
} from "./bot";
import { getEventLog, logEvent } from "./logger";

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
	const deployed = await stub.deploy(payload);
	await new Promise((resolve) => setTimeout(resolve, 2000));
	await announcePresence(targetBot, registry, env, origin);
	logEvent("deploy.complete", {
		bot: targetBot.name,
		knownBots: payload.peers.length,
	});
	return deployed;
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
		await deployBot(stub, targetBot, registry, env, origin);
	}
}

async function announcePresence(
	targetBot: BotDefinition,
	registry: BotRegistry,
	env: Env,
	origin: string,
): Promise<void> {
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

function renderTimeline(events: ReturnType<typeof getEventLog>): Response {
	const items =
		events.length > 0
			? events
					.map((event) => {
						const botName = extractBotName(event.payload);
						const accent = colorForEvent(event.event);
						const botAccent = botName ? colorForBot(botName) : accent;
						const participants = buildParticipantText(event.payload);
						const content = extractContent(event.payload);
						const tooltip = `
              <div class="tooltip-header">
                <span class="pill event-pill">${escapeHtml(event.event)}</span>
                ${
									botName
										? `<span class="pill bot-pill">${escapeHtml(botName)}</span>`
										: ""
								}
                <time>${escapeHtml(event.timestamp)}</time>
              </div>
              ${
								participants
									? `<div class="tooltip-participants">${escapeHtml(participants)}</div>`
									: ""
							}
              ${
								content
									? `<p class="tooltip-content">${escapeHtml(truncate(content, 200))}</p>`
									: ""
							}
            `;
						return `
          <li class="bar" style="--accent:${accent}; --bot:${botAccent};">
            <div class="bar-fill"></div>
            <div class="tooltip">
              ${tooltip}
            </div>
          </li>
        `;
					})
					.join("")
			: '<li class="empty-bar">No events recorded yet.</li>';
	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bot Timeline</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: "Space Grotesk", "DM Sans", "Segoe UI", system-ui, sans-serif;
      }
      body {
        margin: 0;
        padding: 1.5rem 1.5rem 2rem;
        background: radial-gradient(circle at 10% 20%, rgba(80, 200, 255, 0.18), transparent 25%),
          radial-gradient(circle at 90% 10%, rgba(244, 114, 182, 0.2), transparent 28%),
          #06070c;
        color: #eaf0f7;
      }
      h1 {
        margin-top: 0;
        font-size: 1.6rem;
        letter-spacing: 0.01em;
      }
      p {
        color: #b9c3d4;
        margin-bottom: 0.5rem;
      }
      .timeline-shell {
        position: relative;
        margin-top: 1rem;
        padding: 0.75rem 0 0.5rem;
      }
      .timeline {
        list-style: none;
        padding: 1rem 0 0.25rem;
        margin: 0;
        display: flex;
        gap: 6px;
        overflow-x: auto;
        align-items: flex-end;
        height: 130px;
      }
      .timeline::-webkit-scrollbar {
        height: 6px;
      }
      .timeline::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.12);
        border-radius: 999px;
      }
      .track {
        position: absolute;
        top: 58px;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, rgba(80, 200, 255, 0.65), rgba(167, 139, 250, 0.45), rgba(244, 114, 182, 0.6));
        opacity: 0.85;
        border-radius: 999px;
      }
      .bar {
        position: relative;
        flex: 0 0 16px;
        height: 100%;
        display: flex;
        align-items: flex-end;
        justify-content: center;
      }
      .bar-fill {
        position: absolute;
        bottom: 0;
        width: 100%;
        height: 60px;
        background: linear-gradient(180deg, var(--accent, #50c8ff), rgba(255, 255, 255, 0));
        border-radius: 10px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        transition: transform 120ms ease, box-shadow 120ms ease;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .bar:hover .bar-fill {
        transform: translateY(-4px);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
      }
      .tooltip {
        position: absolute;
        bottom: 110%;
        left: 50%;
        transform: translateX(-50%);
        width: 240px;
        background: rgba(9, 12, 20, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        padding: 0.75rem;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease, transform 120ms ease;
        z-index: 10;
      }
      .bar:hover .tooltip {
        opacity: 1;
        transform: translateX(-50%) translateY(-4px);
        pointer-events: auto;
      }
      .tooltip-header {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        flex-wrap: wrap;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 0.7rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }
      .event-pill {
        color: #06121a;
        background: var(--accent, #50c8ff);
      }
      .bot-pill {
        background: rgba(255, 255, 255, 0.08);
        color: #eaf0f7;
        border-color: rgba(255, 255, 255, 0.16);
      }
      .tooltip-participants {
        margin-top: 0.4rem;
        color: #cdd7e6;
        font-size: 0.85rem;
      }
      .tooltip-content {
        margin: 0.4rem 0 0;
        color: #eaf0f7;
        font-size: 0.9rem;
      }
      time {
        font-size: 0.75rem;
        opacity: 0.75;
        margin-left: auto;
      }
      .empty-bar {
        text-align: center;
        padding: 1rem;
        width: 100%;
        color: rgba(255, 255, 255, 0.7);
        border: 1px dashed rgba(255, 255, 255, 0.25);
        border-radius: 0.75rem;
      }
      a {
        color: #50c8ff;
      }
      @media (max-width: 768px) {
        body {
          padding: 1.25rem;
        }
        .timeline {
          height: 110px;
        }
        .tooltip {
          width: 200px;
        }
      }
    </style>
  </head>
  <body>
    <h1>Bot Timeline</h1>
    <p>Showing the latest ${events.length} events captured by the Worker. <a href="/bots/events">Download NDJSON</a></p>
    <div class="timeline-shell">
      <div class="track"></div>
      <ul class="timeline">${items}</ul>
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
		return "#4ac1ff";
	}
	if (event.startsWith("brain.")) {
		return "#f59e0b";
	}
	if (event.startsWith("deploy.")) {
		return "#a78bfa";
	}
	if (event.startsWith("announce")) {
		return "#22d3ee";
	}
	if (event.startsWith("health")) {
		return "#34d399";
	}
	return "#94a3b8";
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
