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
					.map((event, index) => {
						const side = index % 2 === 0 ? "left" : "right";
						const payloadHtml = event.payload
							? `<pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>`
							: "";
						return `
          <li class="event ${side}">
            <div class="bubble">
              <div class="meta">
                <span class="event-type">${escapeHtml(event.event)}</span>
                <time>${escapeHtml(event.timestamp)}</time>
              </div>
              ${payloadHtml}
            </div>
            <span class="dot"></span>
          </li>
        `;
					})
					.join("")
			: '<li class="empty">No events recorded yet.</li>';
	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bot Timeline</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        padding: 1.5rem;
        background: #0b0c10;
        color: #f5f5f5;
      }
      h1 {
        margin-top: 0;
        font-size: 1.5rem;
      }
      .timeline-wrapper {
        position: relative;
        margin-top: 2rem;
        padding-left: 50%;
      }
      .timeline {
        list-style: none;
        padding: 0;
        margin: 0;
        position: relative;
      }
      .timeline::before {
        content: "";
        position: absolute;
        top: 0;
        left: calc(50% - 2px);
        width: 4px;
        height: 100%;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.4), rgba(80, 200, 255, 0.2));
      }
      .event {
        position: relative;
        margin-bottom: 2rem;
        width: 50%;
      }
      .event.left {
        left: -50%;
        padding-right: 2.5rem;
        text-align: right;
      }
      .event.right {
        padding-left: 2.5rem;
      }
      .bubble {
        display: inline-block;
        max-width: 100%;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 1rem;
        border-radius: 1rem;
        box-shadow: 0 0 20px rgba(0, 0, 0, 0.25);
      }
      .dot {
        position: absolute;
        top: 1rem;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #50c8ff;
        box-shadow: 0 0 12px rgba(80, 200, 255, 0.8);
      }
      .event.left .dot {
        right: -8px;
      }
      .event.right .dot {
        left: -8px;
      }
      .event-type {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .meta {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        font-size: 0.9rem;
        color: rgba(255, 255, 255, 0.8);
        margin-bottom: 0.5rem;
      }
      pre {
        margin: 0;
        padding: 0.75rem;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 0.5rem;
        overflow-x: auto;
        font-size: 0.85rem;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        width: 100%;
        color: rgba(255, 255, 255, 0.7);
      }
      a {
        color: #50c8ff;
      }
      @media (max-width: 768px) {
        .timeline-wrapper {
          padding-left: 1.5rem;
        }
        .timeline::before {
          left: 1rem;
        }
        .event,
        .event.left,
        .event.right {
          width: 100%;
          left: 0;
          padding-left: 2rem;
          padding-right: 0;
          text-align: left;
        }
        .event .dot {
          left: -0.5rem;
        }
      }
    </style>
  </head>
  <body>
    <h1>Bot Timeline</h1>
    <p>Showing the latest ${events.length} events captured by the Worker. <a href="/bots/events">Download NDJSON</a></p>
    <div class="timeline-wrapper">
      <ul class="timeline">
        ${items}
      </ul>
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

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
