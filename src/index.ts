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
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const [, root = "", maybeName = "", maybeAction = ""] = url.pathname
			.split("/")
			.map((segment) => segment.trim())
			.map(decodeURIComponent);

		const registry = new BotRegistry(env);

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
	await announcePresence(targetBot, registry, env, origin);
	console.log(
		`[bots] ${targetBot.name} started at ${new Date().toISOString()} (known bots: ${payload.peers.length})`,
	);
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
			} catch (error) {
				console.warn(
					`Failed to announce presence to ${peer.name} on behalf of ${targetBot.name}:`,
					error,
				);
			}
		}),
	);
	await sendMessageBetweenBots(
		targetBot,
		targetBot,
		"I'm here",
		registry,
		env,
		origin,
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
	return timestamp;
}
