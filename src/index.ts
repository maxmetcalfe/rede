import type { ExecutionContext } from "cloudflare:workers";
import {
	BotDurableObject,
	BotRegistry,
	BotDefinition,
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
			const bot = await stub.deploy(targetBot);
			return jsonResponse(
				{
					message: `Bot "${targetBot.name}" deployed.`,
					bot: registry.sanitize(bot),
				},
				{ status: 201 },
			);
		}

		if (maybeAction === "health") {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			try {
				const status = await stub.healthcheck();
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
			const deployed = await stub.deploy(targetBot);
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
