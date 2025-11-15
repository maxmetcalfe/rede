import { DurableObject } from "cloudflare:workers";
import botDefinitions from "../bots.json";

export type BotDefinition = {
	name: string;
	llmApiKey: string;
	prompt: string;
	createdAt?: string;
};

export type BotPeer = {
	name: string;
	botUrl: string;
};

export type BotMessage = {
	timestamp: string;
	content: string;
	botId: string;
};

export type BotMessageInput = {
	botId: string;
	content: string;
	timestamp?: string;
};

export type StoredBot = BotDefinition & {
	createdAt: string;
	knownBots: BotPeer[];
	messages: BotMessage[];
};

export type BotDeploymentPayload = {
	bot: BotDefinition;
	peers: BotPeer[];
};

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

	async deploy(payload: BotDeploymentPayload): Promise<StoredBot> {
		const { bot: botDefinition, peers } = payload;
		const persisted = await this.loadBot();
		const createdAt =
			persisted?.createdAt ??
			botDefinition.createdAt ??
			new Date().toISOString();
		const existingMessages =
			Array.isArray(persisted?.messages) && persisted.messages.length > 0
				? persisted.messages
				: [
						this.buildInitialMessage(botDefinition, createdAt),
					];
		const bot: StoredBot = {
			...botDefinition,
			createdAt,
			knownBots: peers,
			messages: existingMessages,
		};
		await this.ctx.storage.put(BOT_STORAGE_KEY, bot);
		this.bot = bot;
		return bot;
	}

	async getProfile(): Promise<StoredBot> {
		const bot = await this.loadBot();
		if (!bot) {
			throw new Error("Bot has not been deployed yet.");
		}
		let updated = false;
		const knownBots = bot.knownBots ?? [];
		if (!bot.knownBots) {
			updated = true;
		}
		const messages =
			Array.isArray(bot.messages) && bot.messages.length > 0
				? bot.messages
				: [this.buildInitialMessage(bot, bot.createdAt)];
		if (!bot.messages || bot.messages.length === 0) {
			updated = true;
		}
		if (updated) {
			const normalized: StoredBot = {
				...bot,
				knownBots,
				messages,
			};
			await this.ctx.storage.put(BOT_STORAGE_KEY, normalized);
			this.bot = normalized;
			return normalized;
		}
		return bot;
	}

	async healthcheck(): Promise<{
		status: "ok";
		knownBots: number;
		messages: BotMessage[];
	}> {
		const bot = await this.getProfile();
		// Storage SQL call ensures SQLite backend is reachable.
		await this.ctx.storage.sql.exec("SELECT 1 as ok");
		return {
			status: "ok",
			knownBots: bot.knownBots?.length ?? 0,
			messages: bot.messages,
		};
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

	private buildInitialMessage(
		botDefinition: BotDefinition,
		timestamp: string,
	): BotMessage {
		return {
			timestamp,
			content: botDefinition.prompt,
			botId: botDefinition.name,
		};
	}

	private async appendMessage(message: BotMessageInput): Promise<StoredBot> {
		const bot = await this.getProfile();
		const entry: BotMessage = {
			timestamp: message.timestamp ?? new Date().toISOString(),
			content: message.content,
			botId: message.botId,
		};
		const updated: StoredBot = {
			...bot,
			messages: [...bot.messages, entry],
		};
		await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
		this.bot = updated;
		return updated;
	}

	async receiveMessage(message: BotMessageInput): Promise<StoredBot> {
		return this.appendMessage(message);
	}
}
