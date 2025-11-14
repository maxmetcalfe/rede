import { DurableObject } from "cloudflare:workers";
import botDefinitions from "../bots.json";

type BotDefinition = {
	name: string;
	llmApiKey: string;
	prompt: string;
	createdAt?: string;
};

type StoredBot = BotDefinition & { createdAt: string };

const BOT_DEFINITIONS: readonly BotDefinition[] = botDefinitions;
const BOT_STORAGE_KEY = "bot";

const sanitizeBot = (bot: StoredBot) => ({
	...bot,
	llmApiKey: "[hidden]",
});

const jsonResponse = <T>(body: T, init?: ResponseInit) =>
	new Response(JSON.stringify(body, null, 2), {
		headers: {
			"content-type": "application/json",
		},
		...init,
	});

function parseBotFilter(env: Env): Set<string> | undefined {
	if (!env.BOT_DEPLOY_TARGETS) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(env.BOT_DEPLOY_TARGETS);
		if (Array.isArray(parsed)) {
			return new Set(parsed.map((value) => String(value)));
		}
	} catch (error) {
		console.warn("Unable to parse BOT_DEPLOY_TARGETS:", error);
	}
	return undefined;
}

function getActiveBots(env: Env): BotDefinition[] {
	const filter = parseBotFilter(env);
	if (!filter || filter.size === 0) {
		return [...BOT_DEFINITIONS];
	}
	return BOT_DEFINITIONS.filter((bot) => filter.has(bot.name));
}

function getBotDefinition(name: string, env: Env): BotDefinition | undefined {
	return getActiveBots(env).find((bot) => bot.name === name);
}

export class BotDurableObject extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	private bot?: StoredBot;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
	}

	private async loadBot(): Promise<StoredBot | undefined> {
		if (!this.bot) {
			this.bot = await this.state.storage.get<StoredBot>(BOT_STORAGE_KEY);
		}
		return this.bot;
	}

	async deploy(botDefinition: BotDefinition): Promise<StoredBot> {
		const persisted = await this.loadBot();
		const createdAt =
			persisted?.createdAt ??
			botDefinition.createdAt ??
			new Date().toISOString();
		const bot: StoredBot = { ...botDefinition, createdAt };
		await this.state.storage.put(BOT_STORAGE_KEY, bot);
		this.bot = bot;
		return bot;
	}

	async getProfile(): Promise<StoredBot> {
		const bot = await this.loadBot();
		if (!bot) {
			throw new Error("Bot has not been deployed yet.");
		}
		return bot;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		try {
			const profile = await this.getProfile();
			return jsonResponse(sanitizeBot(profile));
		} catch {
			return new Response("Bot is not deployed.", { status: 404 });
		}
	}
}

export class MyDurableObject extends BotDurableObject {}

function ensureBotDefinition(
	name: string,
	env: Env,
): BotDefinition | Response {
	const definition = getBotDefinition(name, env);
	if (!definition) {
		return new Response(`Bot "${name}" is not declared in bots.json.`, {
			status: 404,
		});
	}
	return definition;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const [, root = "", maybeName = "", maybeAction = ""] = url.pathname
			.split("/")
			.map((segment) => segment.trim())
			.map(decodeURIComponent);

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
			const bots = getActiveBots(env).map((bot) => sanitizeBot({
				...bot,
				createdAt: bot.createdAt ?? "not-set",
			}));
			return jsonResponse(bots);
		}

		const definitionOrResponse = ensureBotDefinition(maybeName, env);
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
					bot: sanitizeBot(bot),
				},
				{ status: 201 },
			);
		}

		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		try {
			const profile = await stub.getProfile();
			return jsonResponse(sanitizeBot(profile));
		} catch {
			const deployed = await stub.deploy(targetBot);
			return jsonResponse(
				{
					message: `Bot "${targetBot.name}" was not deployed and has been initialized now.`,
					bot: sanitizeBot(deployed),
				},
				{ status: 201 },
			);
		}
	},
} satisfies ExportedHandler<Env>;
