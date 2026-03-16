import { DurableObject } from "cloudflare:workers";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import botDefinitions from "../bots.json";
import { logEvent } from "./logger";

export type BotDefinition = {
  name: string;
  llmApiKey?: string;
  prompt: string;
  createdAt?: string;
  /**
   * Number of seconds the bot should wait before acting.
   */
  speed?: number;
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

export type CoordinationUpdateType =
  | "claim"
  | "request"
  | "report"
  | "complete";

export type CoordinationStatus = "open" | "in_progress" | "done";

export type CoordinationUpdate = {
  type: CoordinationUpdateType;
  taskId: string;
  summary: string;
  owner?: string;
};

export type CoordinationItem = {
  taskId: string;
  summary: string;
  owner: string;
  status: CoordinationStatus;
  updatedAt: string;
  updatedBy: string;
};

export type StoredBot = BotDefinition & {
  createdAt: string;
  knownBots: BotPeer[];
  messages: BotMessage[];
  coordination: CoordinationItem[];
  /**
   * Timestamp marking the start of the current conversation window.
   */
  sessionStartedAt?: string;
  /**
   * Absolute timestamp when the current session should end.
   */
  sessionKillAt?: string;
  /**
   * Flag set once the conversation window has expired. Prevents duplicate stop notifications.
   */
  sessionStopped?: boolean;
};

export type BotDeploymentPayload = {
  bot: BotDefinition;
  peers: BotPeer[];
};

const BOT_DEFINITIONS: readonly BotDefinition[] = botDefinitions;
export const BOT_STORAGE_KEY = "bot";
const BRAIN_HISTORY_LIMIT = 10;
const BRAIN_MODEL = "gpt-4.1";
const DEFAULT_SESSION_KILL_AFTER_MS = 120_000;
const WEB_FETCH_TIMEOUT_MS = 10_000;
const WEB_FETCH_MAX_CHARS = 20_000;
const PRESENCE_MESSAGE_CONTENT = "I'm here";
const COORDINATION_PREFIX = "COORDINATION_JSON:";

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
    const rawValue = this.readBotDeployTargets();
    if (!rawValue) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(rawValue);
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

  private readBotDeployTargets(): string | undefined {
    // Wrangler dev can inject `--var BOT_DEPLOY_TARGETS=...` as a literal env key.
    for (const [key, value] of Object.entries(this.env)) {
      if (!key.startsWith("BOT_DEPLOY_TARGETS=")) {
        continue;
      }
      const inline = key.slice("BOT_DEPLOY_TARGETS=".length).trim();
      if (inline.length > 0) {
        return inline;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return this.normalizeApiKey(this.env.BOT_DEPLOY_TARGETS);
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
  protected readonly ctx: DurableObjectState<{}>;
  protected readonly env: Env;
  private bot?: StoredBot;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
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
      coordination: persisted?.coordination ?? [],
      sessionStartedAt: persisted?.sessionStartedAt,
      sessionKillAt: persisted?.sessionKillAt,
      sessionStopped: persisted?.sessionStopped,
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
    const coordination = Array.isArray(bot.coordination)
      ? bot.coordination
      : [];
    const sessionKillAt = bot.sessionKillAt;
    if (!bot.messages || bot.messages.length === 0) {
      updated = true;
    }
    if (!Array.isArray(bot.coordination)) {
      updated = true;
    }
    if (updated) {
      const normalized: StoredBot = {
        ...bot,
        knownBots,
        messages,
        coordination,
        sessionKillAt,
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

  async resetState(): Promise<{ status: "ok" }> {
    await this.ctx.storage.deleteAll();
    this.bot = undefined;
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
    const isPresenceMessage = this.isPresenceMessage(message.content);
    const shouldStartNewSession =
      !isPresenceMessage &&
      (!bot.sessionStartedAt ||
        bot.sessionStopped ||
        this.hasConversationExpired(bot));
    const timestamp = message.timestamp ?? new Date().toISOString();
    const entry: BotMessage = {
      timestamp,
      content: message.content,
      botId: message.botId,
    };
    const coordination = this.applyCoordinationUpdates(
      bot.coordination ?? [],
      this.collectCoordinationUpdates(message.botId, message.content),
      timestamp,
      message.botId,
    );
    const sessionStartedAt = shouldStartNewSession
      ? timestamp
      : bot.sessionStartedAt;
    const sessionKillAt = shouldStartNewSession
      ? new Date(
          Date.parse(timestamp) + this.getSessionKillAfterMs(),
        ).toISOString()
      : bot.sessionKillAt;
    const updated: StoredBot = {
      ...bot,
      coordination,
      sessionStartedAt,
      sessionKillAt,
      sessionStopped: shouldStartNewSession ? false : bot.sessionStopped,
      messages: [...bot.messages, entry],
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    if (shouldStartNewSession && updated.sessionStartedAt && updated.sessionKillAt) {
      this.scheduleConversationStop(updated.sessionStartedAt, updated.sessionKillAt);
    }
    return updated;
  }

  async receiveMessage(message: BotMessageInput): Promise<StoredBot> {
    const updated = await this.appendMessage(message);
    const lastMessage =
      updated.messages.length > 0
        ? updated.messages[updated.messages.length - 1]
        : undefined;
    const timestamp = message.timestamp ?? lastMessage?.timestamp;
    logEvent("message.receive", {
      bot: updated.name,
      from: message.botId,
      content: message.content,
      timestamp,
    });
    if (this.isPresenceMessage(message.content)) {
      logEvent("brain.skip", {
        bot: updated.name,
        reason: "presence-message",
      });
      return updated;
    }
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

  private isPresenceMessage(content: string): boolean {
    return content.trim() === PRESENCE_MESSAGE_CONTENT;
  }

  private isTextContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase();
    return (
      normalized.startsWith("text/") ||
      normalized.includes("json") ||
      normalized.includes("xml") ||
      normalized.includes("html")
    );
  }

  private isPrivateIPv4(hostname: string): boolean {
    const parts = hostname.split(".");
    if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
      return false;
    }
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
      return false;
    }
    const [first, second] = numbers;
    if (first === 10 || first === 127) {
      return true;
    }
    if (first === 192 && second === 168) {
      return true;
    }
    if (first === 169 && second === 254) {
      return true;
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
    return false;
  }

  private isPrivateIPv6(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }

  private isBlockedHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".local")) {
      return true;
    }
    return this.isPrivateIPv4(normalized) || this.isPrivateIPv6(normalized);
  }

  private async performWebFetch(url: string, botName: string): Promise<{
    url: string;
    ok: boolean;
    status?: number;
    contentType?: string;
    text?: string;
    truncated?: boolean;
    error?: string;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { url, ok: false, error: "Invalid URL." };
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { url: parsed.toString(), ok: false, error: "Only http/https URLs are allowed." };
    }
    if (this.isBlockedHostname(parsed.hostname)) {
      return { url: parsed.toString(), ok: false, error: "Blocked host." };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: { "user-agent": "rede-bot/1.0" },
      });
      const contentType = response.headers.get("content-type") ?? undefined;
      if (contentType && !this.isTextContentType(contentType)) {
        const result = {
          url: response.url,
          ok: response.ok,
          status: response.status,
          contentType,
          error: "Non-text content type; body not returned.",
        };
        logEvent("tool.web.fetch", { bot: botName, url: result.url, status: result.status, ok: result.ok });
        return result;
      }
      const body = await response.text();
      const truncated = body.length > WEB_FETCH_MAX_CHARS;
      const text = truncated ? body.slice(0, WEB_FETCH_MAX_CHARS) : body;
      const result = {
        url: response.url,
        ok: response.ok,
        status: response.status,
        contentType,
        text,
        truncated,
      };
      logEvent("tool.web.fetch", {
        bot: botName,
        url: result.url,
        status: result.status,
        ok: result.ok,
        truncated,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error");
      const result = { url: parsed.toString(), ok: false, error: message };
      logEvent("tool.web.fetch", { bot: botName, url: result.url, ok: false, error: message });
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async runBotBrain(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<void> {
    let current = bot;
    if (this.hasConversationExpired(current)) {
      current = await this.markConversationStopped(current);
      this.logConversationExpired(current);
      return;
    }
    await this.waitForConfiguredDelay(current);
    if (this.hasConversationExpired(current)) {
      current = await this.markConversationStopped(current);
      this.logConversationExpired(current);
      return;
    }
    const apiKey = this.resolveApiKey(bot);
    if (!apiKey || apiKey === "[hidden]") {
      logEvent("brain.skip", {
        bot: bot.name,
        reason: "missing-api-key",
      });
      return;
    }
    const history = this.buildConversationHistory(bot);
    const coordinationSummary = this.describeCoordination(bot);
    const selfSummary = this.describeSelf(bot);
    const architectureSummary = this.describeArchitecture(bot);
    const peerSummary = this.describePeers(bot);
    const prompt = `${bot.prompt}

Self:
${selfSummary}

Architecture:
${architectureSummary}

Coordination:
${coordinationSummary}

Recent conversation:
${history}

Known bots:
${peerSummary}

You can call the tool web_fetch({ "url": "<https://...>" }) to retrieve web content when needed.
Only call it for public http/https URLs.

You are ${bot.name}. You are a persistent agent backed by a Cloudflare Durable Object.
You know your own public URL and the other bots' URLs from the context above.
Respond concisely to the latest message from ${trigger.botId}.
Operate as a coordinated multi-agent system:
- claim concrete tasks instead of vaguely acknowledging
- avoid duplicating a task already owned by another bot unless you are blocked or asked to help
- if you are taking work, record it as a claim
- if you finish work, record completion
- if you need another bot to do something, send a request to that bot
Reply ONLY with JSON of the shape:
{"message": "<your short reply>", "recipients": ["<botName>", "..."], "coordination": [{"type":"claim|request|report|complete","taskId":"short-kebab-id","owner":"<botName>","summary":"<short task update>"}]}
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
      tools: {
        web_fetch: tool({
          description:
            "Fetch a URL and return a short, truncated text response for public web pages.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Absolute http/https URL to fetch.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          }),
          execute: async ({ url }) => this.performWebFetch(url, bot.name),
        }),
      },
      toolChoice: "auto",
      stopWhen: stepCountIs(3),
    });
    const reply = result.text?.trim();
    if (!reply) {
      logEvent("brain.skip", { bot: bot.name, reason: "empty-reply" });
      return;
    }
    const { message, recipients, coordination } = this.parseBrainResponse(
      reply,
      bot,
      trigger.botId,
    );
    if (!message) {
      logEvent("brain.skip", { bot: bot.name, reason: "unparsable-reply" });
      return;
    }
    const content = this.formatOutgoingMessage(message, coordination);
    const updated = await this.appendMessage({
      botId: bot.name,
      content,
    });
    logEvent("brain.reply", {
      bot: bot.name,
      content: message,
      length: message.length,
      recipients,
      coordination,
    });
    await this.dispatchMessageActions(updated, content, recipients);
  }

  private async markConversationStopped(bot: StoredBot): Promise<StoredBot> {
    if (bot.sessionStopped) {
      return bot;
    }
    const stopped: StoredBot = {
      ...bot,
      sessionStopped: true,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, stopped);
    this.bot = stopped;
    logEvent("conversation.stop", {
      bot: bot.name,
      runId: this.env.RUN_ID,
      startedAt: bot.sessionStartedAt,
      killAt: bot.sessionKillAt,
      ttlSeconds: this.getSessionTtlSeconds(bot),
    });
    return stopped;
  }

  private scheduleConversationStop(startedAt: string, killAt: string): void {
    const killAtMs = Date.parse(killAt);
    const delayMs = Number.isFinite(killAtMs)
      ? Math.max(0, killAtMs - Date.now())
      : this.getSessionKillAfterMs();
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const latest = await this.getProfile().catch(() => undefined);
        if (
          !latest ||
          latest.sessionStopped ||
          latest.sessionStartedAt !== startedAt ||
          latest.sessionKillAt !== killAt
        ) {
          return;
        }
        const stopped = await this.markConversationStopped(latest);
        this.logConversationExpired(stopped);
      })(),
    );
  }

  private hasConversationExpired(bot: StoredBot): boolean {
    if (!bot.sessionStartedAt) {
      return false;
    }
    const killAtMs = this.getSessionKillAtMs(bot);
    if (!Number.isFinite(killAtMs)) {
      return false;
    }
    return Date.now() >= killAtMs;
  }

  private logConversationExpired(bot: StoredBot): void {
    logEvent("brain.skip", {
      bot: bot.name,
      reason: "conversation-expired",
      startedAt: bot.sessionStartedAt,
      killAt: bot.sessionKillAt,
      ttlSeconds: this.getSessionTtlSeconds(bot),
    });
  }

  private getSessionKillAfterMs(): number {
    const value = this.readInlineEnvValue("SESSION_KILL_AFTER_SECONDS");
    if (typeof value !== "string") {
      return DEFAULT_SESSION_KILL_AFTER_MS;
    }
    const seconds = Number(value.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return DEFAULT_SESSION_KILL_AFTER_MS;
    }
    return seconds * 1000;
  }

  private readInlineEnvValue(name: string): string | undefined {
    for (const [key, value] of Object.entries(this.env)) {
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
    const direct = this.env[name as keyof Env];
    return typeof direct === "string" && direct.trim().length > 0
      ? direct.trim()
      : undefined;
  }

  private getSessionKillAtMs(bot: StoredBot): number {
    if (typeof bot.sessionKillAt === "string") {
      const parsed = Date.parse(bot.sessionKillAt);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    if (typeof bot.sessionStartedAt === "string") {
      const startedAtMs = Date.parse(bot.sessionStartedAt);
      if (Number.isFinite(startedAtMs)) {
        return startedAtMs + this.getSessionKillAfterMs();
      }
    }
    return Number.NaN;
  }

  private getSessionTtlSeconds(bot: StoredBot): number {
    const startedAtMs =
      typeof bot.sessionStartedAt === "string"
        ? Date.parse(bot.sessionStartedAt)
        : Number.NaN;
    const killAtMs = this.getSessionKillAtMs(bot);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(killAtMs)) {
      return this.getSessionKillAfterMs() / 1000;
    }
    return Math.max(0, Math.round((killAtMs - startedAtMs) / 1000));
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
    return recent
      .map((entry) => `${entry.botId}: ${this.stripCoordinationPayload(entry.content)}`)
      .join("\n");
  }

  private describeSelf(bot: StoredBot): string {
    const selfPeer = (bot.knownBots ?? []).find((peer) => peer.name === bot.name);
    return [
      `name: ${bot.name}`,
      `url: ${selfPeer?.botUrl ?? "unknown"}`,
      `createdAt: ${bot.createdAt}`,
      `speedSeconds: ${Number(bot.speed ?? 0)}`,
      `conversationWindowSeconds: ${this.getSessionKillAfterMs() / 1000}`,
      `sessionKillAt: ${bot.sessionKillAt ?? "unknown"}`,
    ].join("\n");
  }

  private describeArchitecture(bot: StoredBot): string {
    const peerCount = Math.max((bot.knownBots?.length ?? 1) - 1, 0);
    return [
      "runtime: Cloudflare Workers + Durable Objects",
      "topology: one BotDurableObject class with many named instances",
      "execution: message-driven LLM agent",
      "state: prompt, peer list, message history, conversation window",
      "messaging: bots exchange messages via worker endpoints",
      "brain: OpenAI model via Vercel AI SDK",
      "tools: web_fetch for public web pages",
      `knownPeerCount: ${peerCount}`,
    ].join("\n");
  }

  private describeCoordination(bot: StoredBot): string {
    const items = bot.coordination ?? [];
    if (items.length === 0) {
      return "No tasks have been claimed yet.";
    }
    return items
      .slice(-10)
      .map(
        (item) =>
          `${item.taskId} | owner=${item.owner} | status=${item.status} | summary=${item.summary}`,
      )
      .join("\n");
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

  private async waitForConfiguredDelay(bot: StoredBot): Promise<void> {
    const delayMs = this.parseBotDelayMs(bot);
    if (delayMs <= 0) {
      return;
    }
    logEvent("bot.wait", { bot: bot.name, seconds: delayMs / 1000 });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private parseBotDelayMs(bot: StoredBot): number {
    const delaySeconds = Number(bot.speed ?? 0);
    if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
      return 0;
    }
    return delaySeconds * 1000;
  }

  private parseBrainResponse(
    raw: string,
    bot: StoredBot,
    fallbackRecipient: string,
  ): { message: string; recipients: string[]; coordination: CoordinationUpdate[] } {
    const parsed = this.extractJson(raw);
    const peers = bot.knownBots ?? [];
    const peerNames = new Set(peers.map((peer) => peer.name));
    if (parsed && typeof parsed.message === "string") {
      const requested = Array.isArray(parsed.recipients)
        ? parsed.recipients.filter((value) => typeof value === "string")
        : [];
      const coordination = this.normalizeCoordinationUpdates(
        parsed.coordination,
        bot.name,
      );
      const filtered = requested.filter(
        (name) => name !== bot.name && peerNames.has(name),
      );
      return {
        message: parsed.message.trim(),
        recipients: filtered.length > 0 ? filtered : [fallbackRecipient],
        coordination,
      };
    }
    const fallbackMessage = raw.trim();
    return {
      message: fallbackMessage,
      recipients:
        peerNames.has(fallbackRecipient) && fallbackRecipient !== bot.name
          ? [fallbackRecipient]
          : peers.map((peer) => peer.name).filter((name) => name !== bot.name),
      coordination: this.inferCoordinationUpdates(bot.name, fallbackMessage),
    };
  }

  private extractJson(
    raw: string,
  ): { message?: string; recipients?: unknown; coordination?: unknown } | null {
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

  private normalizeCoordinationUpdates(
    value: unknown,
    defaultOwner: string,
  ): CoordinationUpdate[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const update = item as Partial<CoordinationUpdate>;
      if (
        typeof update.type !== "string" ||
        typeof update.taskId !== "string" ||
        typeof update.summary !== "string"
      ) {
        return [];
      }
      const type = update.type.trim() as CoordinationUpdateType;
      if (!["claim", "request", "report", "complete"].includes(type)) {
        return [];
      }
      return [
        {
          type,
          taskId: update.taskId.trim(),
          summary: update.summary.trim(),
          owner:
            typeof update.owner === "string" && update.owner.trim().length > 0
              ? update.owner.trim()
              : defaultOwner,
        },
      ];
    });
  }

  private inferCoordinationUpdates(
    sender: string,
    content: string,
  ): CoordinationUpdate[] {
    const normalized = content.trim();
    const updates: CoordinationUpdate[] = [];
    const patterns = [
      /\b(?:i am going to|i'm going to|i will|i'll)\s+([^.!?\n]+)/gi,
      /\b(?:great,\s*)?(?:i am|i'm)\s+([^.!?\n]+)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of normalized.matchAll(pattern)) {
        const summary = match[1]?.trim();
        if (!summary) {
          continue;
        }
        updates.push({
          type: "claim",
          taskId: this.buildTaskId(sender, summary),
          summary,
          owner: sender,
        });
      }
    }
    if (updates.length > 0) {
      return updates;
    }
    if (/\b(done|finished|completed)\b/i.test(normalized)) {
      return [
        {
          type: "complete",
          taskId: this.buildTaskId(sender, normalized),
          summary: normalized,
          owner: sender,
        },
      ];
    }
    return [];
  }

  private collectCoordinationUpdates(
    sender: string,
    content: string,
  ): CoordinationUpdate[] {
    const embedded = this.extractCoordinationPayload(content);
    if (embedded.length > 0) {
      return embedded;
    }
    return this.inferCoordinationUpdates(
      sender,
      this.stripCoordinationPayload(content),
    );
  }

  private applyCoordinationUpdates(
    existing: CoordinationItem[],
    updates: CoordinationUpdate[],
    timestamp: string,
    updatedBy: string,
  ): CoordinationItem[] {
    if (updates.length === 0) {
      return existing;
    }
    const byId = new Map(existing.map((item) => [item.taskId, item]));
    for (const update of updates) {
      const current = byId.get(update.taskId);
      const owner = update.owner?.trim() || current?.owner || updatedBy;
      const status = this.statusForUpdate(update.type, current?.status);
      byId.set(update.taskId, {
        taskId: update.taskId,
        summary: update.summary,
        owner,
        status,
        updatedAt: timestamp,
        updatedBy,
      });
    }
    return Array.from(byId.values()).sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    );
  }

  private statusForUpdate(
    type: CoordinationUpdateType,
    previous?: CoordinationStatus,
  ): CoordinationStatus {
    if (type === "complete") {
      return "done";
    }
    if (type === "claim") {
      return "in_progress";
    }
    if (type === "request") {
      return previous === "done" ? "done" : "open";
    }
    return previous ?? "in_progress";
  }

  private formatOutgoingMessage(
    message: string,
    coordination: CoordinationUpdate[],
  ): string {
    if (coordination.length === 0) {
      return message;
    }
    return `${message}\n\n${COORDINATION_PREFIX}${JSON.stringify(coordination)}`;
  }

  private stripCoordinationPayload(content: string): string {
    const markerIndex = content.indexOf(COORDINATION_PREFIX);
    if (markerIndex === -1) {
      return content.trim();
    }
    return content.slice(0, markerIndex).trim();
  }

  private extractCoordinationPayload(content: string): CoordinationUpdate[] {
    const markerIndex = content.indexOf(COORDINATION_PREFIX);
    if (markerIndex === -1) {
      return [];
    }
    const raw = content.slice(markerIndex + COORDINATION_PREFIX.length).trim();
    try {
      return this.normalizeCoordinationUpdates(JSON.parse(raw), "");
    } catch {
      return [];
    }
  }

  private buildTaskId(owner: string, summary: string): string {
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return `${owner.toLowerCase()}-${slug || "task"}`;
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
