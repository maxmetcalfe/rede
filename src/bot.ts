import { DurableObject } from "cloudflare:workers";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import botDefinitions from "../bots.json";
import { logEvent } from "./logger";

export type BotDefinition = {
  name: string;
  llmApiKey?: string;
  prompt: string;
  createdAt?: string;
};

export type BotPeer = {
  name: string;
  botUrl: string;
  prompt?: string;
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
const BRAIN_HISTORY_LIMIT = 10;
const BRAIN_MODEL = "gpt-4.1";

export const jsonResponse = <T>(body: T, init?: ResponseInit) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });

export class BotRegistry {
  private readonly filter?: Set<string>;
  private readonly openAiApiKey?: string;

  constructor(private readonly env: Env) {
    this.filter = this.parseBotFilter();
    this.openAiApiKey = this.normalizeApiKey(env.OPENAI_API_KEY);
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

  private normalizeApiKey(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
    const masked = this.normalizeApiKey(bot.llmApiKey) ?? this.openAiApiKey;
    return {
      ...bot,
      llmApiKey: masked ? "[hidden]" : "[missing]",
    } as T;
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
        : [this.buildInitialMessage(botDefinition, createdAt)];
    const bot: StoredBot = {
      ...botDefinition,
      createdAt,
      knownBots: peers,
      messages: existingMessages,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, bot);
    this.bot = bot;
    logEvent("durable.deploy", {
      bot: botDefinition.name,
      knownBots: peers.length,
    });
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
    const updated = await this.appendMessage(message);
    const timestamp = message.timestamp ?? updated.messages.at(-1)?.timestamp;
    logEvent("message.receive", {
      bot: updated.name,
      from: message.botId,
      content: message.content,
      timestamp,
    });
    this.ctx.waitUntil(
      this.runBotBrain(updated, message).catch((error) => {
        logEvent("brain.error", {
          bot: updated.name,
          error:
            error instanceof Error
              ? error.message
              : String(error ?? "unknown error"),
        });
      }),
    );
    return updated;
  }

  private async runBotBrain(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<void> {
    const apiKey = this.resolveApiKey(bot);
    if (!apiKey || apiKey === "[hidden]") {
      logEvent("brain.skip", {
        bot: bot.name,
        reason: "missing-api-key",
      });
      return;
    }
    const history = this.buildConversationHistory(bot);
    const peerSummary = this.describePeers(bot);
    const prompt = `${bot.prompt}

Recent conversation:
${history}

Known bots:
${peerSummary}

You are ${bot.name}. Respond concisely to the latest message from ${trigger.botId}.
Choose who should receive this reply. Reply ONLY with JSON of the shape:
{"message": "<your short reply>", "recipients": ["<botName>", "..."]}
- Use bot names from the known bots list (exclude yourself).
- Include at least one recipient when your reply should be shared.`;
    logEvent("brain.start", {
      bot: bot.name,
      lastMessageFrom: trigger.botId,
    });
    const client = createOpenAI({ apiKey });
    const result = await generateText({
      model: client(BRAIN_MODEL),
      prompt,
    });
    const reply = result.text?.trim();
    if (!reply) {
      logEvent("brain.skip", { bot: bot.name, reason: "empty-reply" });
      return;
    }
    const { message, recipients } = this.parseBrainRouting(
      reply,
      bot,
      trigger.botId,
    );
    if (!message) {
      logEvent("brain.skip", { bot: bot.name, reason: "unparsable-reply" });
      return;
    }
    const updated = await this.appendMessage({
      botId: bot.name,
      content: message,
    });
    logEvent("brain.reply", {
      bot: bot.name,
      content: message,
      length: message.length,
      recipients,
    });
    await this.dispatchMessageActions(updated, message, recipients);
  }

  private resolveApiKey(bot: StoredBot): string | undefined {
    const candidate = bot.llmApiKey ?? this.env.OPENAI_API_KEY;
    if (typeof candidate !== "string") {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildConversationHistory(bot: StoredBot): string {
    const recent = bot.messages.slice(-BRAIN_HISTORY_LIMIT);
    return recent.map((entry) => `${entry.botId}: ${entry.content}`).join("\n");
  }

  private describePeers(bot: StoredBot): string {
    const peers = bot.knownBots ?? [];
    if (peers.length === 0) {
      return "No other bots are known yet.";
    }
    return peers
      .filter((peer) => peer.name !== bot.name)
      .map((peer) => `${peer.name}: ${peer.prompt ?? "No prompt available."}`)
      .join("\n");
  }

  private parseBrainRouting(
    raw: string,
    bot: StoredBot,
    fallbackRecipient: string,
  ): { message: string; recipients: string[] } {
    const parsed = this.extractJson(raw);
    const peers = bot.knownBots ?? [];
    const peerNames = new Set(peers.map((peer) => peer.name));
    if (parsed && typeof parsed.message === "string") {
      const requested = Array.isArray(parsed.recipients)
        ? parsed.recipients.filter((value) => typeof value === "string")
        : [];
      const filtered = requested.filter(
        (name) => name !== bot.name && peerNames.has(name),
      );
      return {
        message: parsed.message.trim(),
        recipients: filtered.length > 0 ? filtered : [fallbackRecipient],
      };
    }
    const fallbackMessage = raw.trim();
    return {
      message: fallbackMessage,
      recipients:
        peerNames.has(fallbackRecipient) && fallbackRecipient !== bot.name
          ? [fallbackRecipient]
          : peers.map((peer) => peer.name).filter((name) => name !== bot.name),
    };
  }

  private extractJson(
    raw: string,
  ): { message?: string; recipients?: unknown } | null {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  private getOriginFromKnownBots(peers: BotPeer[]): string | undefined {
    const example = peers.find((peer) => peer.botUrl);
    if (!example) {
      return undefined;
    }
    try {
      return new URL(example.botUrl).origin;
    } catch {
      return undefined;
    }
  }

  private async dispatchMessageActions(
    bot: StoredBot,
    content: string,
    recipients: string[],
  ): Promise<void> {
    const peers = (bot.knownBots ?? []).filter(
      (peer) => peer.name !== bot.name,
    );
    const targetSet = new Set(recipients);
    const targets = peers.filter((peer) => targetSet.has(peer.name));
    if (peers.length === 0) {
      logEvent("message.broadcast.skip", { bot: bot.name, reason: "no-peers" });
      return;
    }
    if (targets.length === 0) {
      logEvent("message.broadcast.skip", {
        bot: bot.name,
        reason: "no-matching-recipients",
        requested: recipients,
      });
      return;
    }
    const origin = this.getOriginFromKnownBots(peers);
    if (!origin) {
      logEvent("message.broadcast.skip", {
        bot: bot.name,
        reason: "missing-origin",
      });
      return;
    }
    const messageEndpoint = new URL(
      `/bots/${encodeURIComponent(bot.name)}/message`,
      origin,
    );
    await Promise.all(
      targets.map(async (peer) => {
        try {
          const response = await fetch(messageEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to: peer.name, content }),
          });
          if (!response.ok) {
            logEvent("message.broadcast.error", {
              from: bot.name,
              to: peer.name,
              status: response.status,
            });
            return;
          }
          logEvent("message.broadcast.sent", {
            from: bot.name,
            to: peer.name,
            content,
          });
        } catch (error) {
          logEvent("message.broadcast.error", {
            from: bot.name,
            to: peer.name,
            error:
              error instanceof Error
                ? error.message
                : String(error ?? "unknown error"),
          });
        }
      }),
    );
  }
}
