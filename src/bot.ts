import { DurableObject } from "cloudflare:workers";
import botDefinitions from "../bots.json";

export type BotDefinition = {
	name: string;
	llmApiKey: string;
	prompt: string;
	createdAt?: string;
};

export type StoredBot = BotDefinition & { createdAt: string };

const BOT_DEFINITIONS: readonly BotDefinition[] = botDefinitions;
export const BOT_STORAGE_KEY = "bot";

export const jsonResponse = <T>(body: T, init?: ResponseInit) =>
	new Response(JSON.stringify(body, null, 2), {
		headers: {
			"content-type": "application/json",
		},
		...init,
	});

export class BotRegistry {
	private readonly filter?: Set<string>;

	constructor(private readonly env: Env) {
		this.filter = this.parseBotFilter();
	}

	private parseBotFilter(): Set<string> | undefined {
		if (!this.env.BOT_DEPLOY_TARGETS) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(this.env.BOT_DEPLOY_TARGETS);
			if (Array.isArray(parsed)) {
				return new Set(parsed.map((value) => String(value)));
			}
		} catch (error) {
			console.warn("Unable to parse BOT_DEPLOY_TARGETS:", error);
		}
		return undefined;
	}

	getActiveBots(): BotDefinition[] {
		if (!this.filter || this.filter.size === 0) {
			return [...BOT_DEFINITIONS];
		}
		return BOT_DEFINITIONS.filter((bot) => this.filter!.has(bot.name));
	}

	getBotDefinition(name: string): BotDefinition | undefined {
		return this.getActiveBots().find((bot) => bot.name === name);
	}

	sanitize<T extends BotDefinition | StoredBot>(bot: T): T {
		return {
			...bot,
			llmApiKey: "[hidden]",
		};
	}
}

export class BotDurableObject extends DurableObject<Env> {
	protected readonly ctx: DurableObjectState;
	protected readonly env: Env;
	private bot?: StoredBot;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx = ctx;
		this.env = env;
	}

	private async loadBot(): Promise<StoredBot | undefined> {
		if (!this.bot) {
			this.bot = await this.ctx.storage.get<StoredBot>(BOT_STORAGE_KEY);
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
		await this.ctx.storage.put(BOT_STORAGE_KEY, bot);
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

	async healthcheck(): Promise<{ status: "ok" }> {
		await this.getProfile();
		// Storage SQL call ensures SQLite backend is reachable.
		await this.ctx.storage.sql.exec("SELECT 1 as ok");
		return { status: "ok" };
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const registry = new BotRegistry(this.env);
		try {
			const profile = await this.getProfile();
			return jsonResponse(registry.sanitize(profile));
		} catch {
			return new Response("Bot is not deployed.", { status: 404 });
		}
	}
}
