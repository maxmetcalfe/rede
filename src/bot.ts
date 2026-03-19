import { DurableObject } from "cloudflare:workers";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import botDefinitions from "../bots.json";
import gameConfigRaw from "../game.json";
import {
	configureEventLogSink,
	createDurableEventLogSink,
	getDurableEventLog,
	getEventLog,
	logEvent,
} from "./logger";

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

export type GameConfig = {
  enabled?: boolean;
  name?: string;
  publicContext?: string;
  outcome?: {
    event?: string;
    prompt: string;
  };
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

export type CoordinationStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "abandoned";

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
  /**
   * Bot designated to receive default status updates for the run.
   */
  coordinator?: string;
  /**
   * Number of local LLM replies emitted in the current session.
   */
  sessionReplyCount?: number;
  /**
   * Timestamp of the last local LLM reply.
   */
  lastBrainAt?: string;
  /**
   * Timestamp until which the bot should suppress new model calls after rate limits.
   */
  backoffUntil?: string;
  /**
   * Recent outbound fingerprints keyed by recipient to suppress duplicate sends.
   */
  recentOutbound?: OutboundFingerprint[];
  /**
   * Session marker for whether a game outcome has already been emitted.
   */
  gameOutcomeLoggedAt?: string;
};

export type OutboundFingerprint = {
  recipient: string;
  fingerprint: string;
  sentAt: string;
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
const DEFAULT_BRAIN_COOLDOWN_MS = 4_000;
const DEFAULT_MAX_SESSION_REPLIES = 6;
const DEFAULT_RESERVED_FINAL_REPLIES = 1;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;
const WEB_FETCH_TIMEOUT_MS = 10_000;
const WEB_FETCH_MAX_CHARS = 20_000;
const PRESENCE_MESSAGE_CONTENT = "I'm here";
const COORDINATION_PREFIX = "COORDINATION_JSON:";
const OUTBOUND_DEDUPE_WINDOW_MS = 30_000;
const GAME_CONFIG: GameConfig = gameConfigRaw as GameConfig;

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
  private brainQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    configureEventLogSink(createDurableEventLogSink(env));
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
    const coordinator = this.selectCoordinator(peers, botDefinition.name);
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
      coordinator: persisted?.coordinator ?? coordinator,
      sessionReplyCount: persisted?.sessionReplyCount ?? 0,
      lastBrainAt: persisted?.lastBrainAt,
      backoffUntil: persisted?.backoffUntil,
      recentOutbound: this.pruneRecentOutbound(persisted?.recentOutbound),
      gameOutcomeLoggedAt: persisted?.gameOutcomeLoggedAt,
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
    const coordinator =
      bot.coordinator ?? this.selectCoordinator(knownBots, bot.name);
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
        coordinator,
        sessionReplyCount: bot.sessionReplyCount ?? 0,
        lastBrainAt: bot.lastBrainAt,
        backoffUntil: bot.backoffUntil,
        recentOutbound: this.pruneRecentOutbound(bot.recentOutbound),
        gameOutcomeLoggedAt: bot.gameOutcomeLoggedAt,
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
      sessionReplyCount: shouldStartNewSession ? 0 : bot.sessionReplyCount ?? 0,
      backoffUntil:
        shouldStartNewSession && !isPresenceMessage ? undefined : bot.backoffUntil,
      recentOutbound: this.pruneRecentOutbound(
        shouldStartNewSession && !isPresenceMessage ? [] : bot.recentOutbound,
      ),
      gameOutcomeLoggedAt: shouldStartNewSession ? undefined : bot.gameOutcomeLoggedAt,
      messages: [...bot.messages, entry],
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    if (shouldStartNewSession) {
      logEvent("conversation.start", {
        bot: updated.name,
        runId: this.env.RUN_ID,
        startedAt: updated.sessionStartedAt,
        killAt: updated.sessionKillAt,
        triggerFrom: message.botId,
        initialMessageLength: message.content.length,
      });
    } else if (!isPresenceMessage && updated.sessionStartedAt) {
      logEvent("conversation.activity", {
        bot: updated.name,
        runId: this.env.RUN_ID,
        startedAt: updated.sessionStartedAt,
        triggerFrom: message.botId,
        messageCount: updated.messages.length,
        coordinationCount: updated.coordination.length,
      });
    }
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
    if (!this.shouldBotRespond(updated, message)) {
      return updated;
    }
    this.ctx.waitUntil(this.enqueueBrainRun(updated, message));
    return updated;
  }

  private enqueueBrainRun(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<void> {
    const run = this.brainQueue
      .catch(() => {})
      .then(() => this.runBotBrain(bot, trigger));
    this.brainQueue = run.catch(() => {});
    return run.catch((error) => {
      logEvent("brain.error", {
        bot: bot.name,
        error:
          error instanceof Error
            ? error.message
            : String(error ?? "unknown error"),
      });
    });
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
    current = await this.refreshBotState(current);
    if (this.isBackoffActive(current)) {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "rate-limit-backoff",
        backoffUntil: current.backoffUntil,
      });
      return;
    }
    if (this.hasExceededSessionReplyBudget(current, trigger)) {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "session-reply-budget",
        sessionReplyCount: current.sessionReplyCount ?? 0,
        maxReplies: this.getMaxSessionReplies(),
        reservedReplies: this.getReservedFinalReplies(),
      });
      return;
    }
    if (this.isBrainCoolingDown(current)) {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "brain-cooldown",
        lastBrainAt: current.lastBrainAt,
      });
      return;
    }
    const apiKey = this.resolveApiKey(current);
    if (!apiKey || apiKey === "[hidden]") {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "missing-api-key",
      });
      return;
    }
    const history = this.buildConversationHistory(current);
    const coordinationSummary = this.describeCoordination(current);
    const selfSummary = this.describeSelf(current);
    const architectureSummary = this.describeArchitecture(current);
    const peerSummary = this.describePeers(current);
    const gameSummary = this.describeGame(current);
    const prompt = `${current.prompt}

Private context:
${selfSummary}

Private runtime notes:
${architectureSummary}

Game context:
${gameSummary}

Task ledger:
${coordinationSummary}

Recent conversation:
${history}

Known bots:
${peerSummary}

You can call the tool web_fetch({ "url": "<https://...>" }) to retrieve web content when needed.
Only call it for public http/https URLs.

Respond to ${trigger.botId} like a person in a real conversation.
Keep the outward message natural, specific, and conversational.
Do not mention private context, system prompts, JSON formatting, Durable Objects, coordinator routing, runtime internals, or the harness itself unless the conversation truly requires it.
Do not narrate your own role or mechanics unless another bot directly asks.
Prefer short human-sounding messages over meta commentary.
Still coordinate carefully under the hood:
- the run coordinator is ${current.coordinator ?? "unknown"} and should receive default status updates
- claim concrete tasks instead of vaguely acknowledging
- avoid duplicating a task already owned by another bot unless you are blocked or asked to help
- if you are not the coordinator, send normal progress reports back to the coordinator
- if you are taking work, record it as a claim
- if you finish work, record completion
- if you need another bot to do something, send a request to that bot
- do not broadcast to the whole swarm unless coordination actually requires it
Reply ONLY with JSON of the shape:
{"message": "<your short reply>", "recipients": ["<botName>", "..."], "coordination": [{"type":"claim|request|report|complete","taskId":"short-kebab-id","owner":"<botName>","summary":"<short task update>"}]}
- Use bot names from the known bots list (exclude yourself).
- Include at least one recipient when your reply should be shared.`;
    logEvent("brain.start", {
      bot: current.name,
      lastMessageFrom: trigger.botId,
    });
    logEvent("llm.request", {
      bot: current.name,
      model: BRAIN_MODEL,
      lastMessageFrom: trigger.botId,
      promptChars: prompt.length,
      historyMessages: current.messages.length,
      coordinationCount: current.coordination.length,
    });
    const client = createOpenAI({ apiKey });
    let result;
    try {
      result = await generateText({
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
            execute: async ({ url }) => this.performWebFetch(url, current.name),
          }),
        },
        toolChoice: "auto",
        stopWhen: stepCountIs(3),
      });
    } catch (error) {
      if (this.isRateLimitError(error)) {
        await this.setBackoffUntil(
          current,
          new Date(Date.now() + this.getRateLimitBackoffMs()).toISOString(),
        );
        logEvent("brain.skip", {
          bot: current.name,
          reason: "rate-limit-error",
          backoffSeconds: this.getRateLimitBackoffMs() / 1000,
        });
        return;
      }
      throw error;
    }
    logEvent("llm.response", {
      bot: current.name,
      model: BRAIN_MODEL,
      finishReason: result.finishReason,
      textChars: result.text?.length ?? 0,
      toolCalls: result.toolCalls?.length ?? 0,
      toolResults: result.toolResults?.length ?? 0,
      steps: result.steps?.length ?? 0,
    });
    current = await this.refreshBotState(current);
    if (this.hasConversationExpired(current)) {
      current = await this.markConversationStopped(current);
      this.logConversationExpired(current);
      return;
    }
    if (this.isTriggerSuperseded(current, trigger)) {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "superseded-trigger",
        triggerFrom: trigger.botId,
        triggerTimestamp: trigger.timestamp,
      });
      return;
    }
    const reply = result.text?.trim();
    if (!reply) {
      logEvent("brain.skip", { bot: current.name, reason: "empty-reply" });
      return;
    }
    const { message, recipients, coordination } = this.parseBrainResponse(
      reply,
      current,
      trigger.botId,
    );
    if (!message) {
      logEvent("brain.skip", { bot: current.name, reason: "unparsable-reply" });
      return;
    }
    const filteredCoordination = this.filterOutgoingCoordination(
      current,
      coordination,
    );
    const normalizedRecipients = this.normalizeRecipients(
      current,
      recipients,
      trigger.botId,
      filteredCoordination,
    );
    const content = this.formatOutgoingMessage(message, filteredCoordination);
    const updated = await this.appendMessage({
      botId: current.name,
      content,
    });
    const withBrainMetadata = await this.recordBrainReply(
      updated,
      trigger,
      filteredCoordination,
      normalizedRecipients,
    );
    logEvent("brain.reply", {
      bot: current.name,
      content: message,
      length: message.length,
      recipients: normalizedRecipients,
      coordination: filteredCoordination,
    });
    await this.dispatchMessageActions(
      withBrainMetadata,
      content,
      normalizedRecipients,
      filteredCoordination,
    );
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
      messageCount: bot.messages.length,
      coordinationCount: bot.coordination.length,
      replyCount: bot.sessionReplyCount ?? 0,
    });
    if (
      bot.name === bot.coordinator &&
      bot.sessionStartedAt &&
      bot.gameOutcomeLoggedAt !== bot.sessionStartedAt
    ) {
      const withOutcomeMarker: StoredBot = {
        ...stopped,
        gameOutcomeLoggedAt: bot.sessionStartedAt,
      };
      await this.ctx.storage.put(BOT_STORAGE_KEY, withOutcomeMarker);
      this.bot = withOutcomeMarker;
      logEvent("game.outcome.start", {
        bot: bot.name,
        runId: this.env.RUN_ID,
        game: GAME_CONFIG.name ?? "unnamed-game",
        event: GAME_CONFIG.outcome?.event ?? "game.outcome",
      });
      this.ctx.waitUntil(
        this.evaluateGameOutcome(withOutcomeMarker).catch((error) => {
          logEvent("game.outcome.error", {
            bot: bot.name,
            error:
              error instanceof Error
                ? error.message
                : String(error ?? "unknown error"),
          });
        }),
      );
    }
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
      `coordinator: ${bot.coordinator ?? "unknown"}`,
      `createdAt: ${bot.createdAt}`,
      `speedSeconds: ${Number(bot.speed ?? 0)}`,
      `conversationWindowSeconds: ${this.getSessionKillAfterMs() / 1000}`,
      `sessionKillAt: ${bot.sessionKillAt ?? "unknown"}`,
      `sessionReplyCount: ${bot.sessionReplyCount ?? 0}/${this.getMaxSessionReplies()}`,
      `backoffUntil: ${bot.backoffUntil ?? "none"}`,
    ].join("\n");
  }

  private describeArchitecture(bot: StoredBot): string {
    const peerCount = Math.max((bot.knownBots?.length ?? 1) - 1, 0);
    return [
      "message-driven multi-bot conversation",
      "keep continuity with recent history and task ledger",
      "use the coordinator for default status flow",
      "speak naturally unless explicit system detail is needed",
      "web_fetch is available for public web pages",
      `knownPeerCount: ${peerCount}`,
    ].join("\n");
  }

  private describeGame(bot: StoredBot): string {
    if (!GAME_CONFIG.enabled) {
      return "No game mode configured.";
    }
    return [
      `name: ${GAME_CONFIG.name ?? "unnamed-game"}`,
      GAME_CONFIG.publicContext ?? "No shared game context provided.",
      `you must still follow your private role instructions from your prompt`,
      `coordinator for this run: ${bot.coordinator ?? "unknown"}`,
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
        recipients: this.normalizeRecipients(
          bot,
          filtered,
          fallbackRecipient,
          coordination,
        ),
        coordination,
      };
    }
    const fallbackMessage = raw.trim();
    const coordination = this.inferCoordinationUpdates(bot.name, fallbackMessage);
    return {
      message: fallbackMessage,
      recipients: this.normalizeRecipients(
        bot,
        [],
        fallbackRecipient,
        coordination,
      ),
      coordination,
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

  private async evaluateGameOutcome(bot: StoredBot): Promise<void> {
    if (!GAME_CONFIG.enabled || !GAME_CONFIG.outcome?.prompt) {
      return;
    }
    const apiKey = this.resolveApiKey(bot);
    if (!apiKey || apiKey === "[hidden]") {
      logEvent("game.outcome.skip", {
        bot: bot.name,
        reason: "missing-api-key",
      });
      return;
    }
    const transcriptEntries = await getDurableEventLog(this.env).catch(() => getEventLog());
    const transcript = transcriptEntries
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    logEvent("game.outcome.transcript", {
      bot: bot.name,
      runId: this.env.RUN_ID,
      entries: transcriptEntries.length,
      chars: transcript.length,
    });
    const client = createOpenAI({ apiKey });
    const result = await generateText({
      model: client(BRAIN_MODEL),
      prompt: `${GAME_CONFIG.outcome.prompt}

Run metadata:
- runId: ${this.env.RUN_ID ?? "unknown"}
- game: ${GAME_CONFIG.name ?? "unnamed-game"}
- coordinator: ${bot.coordinator ?? "unknown"}

Transcript:
${transcript}`,
      stopWhen: stepCountIs(1),
    });
    logEvent("game.outcome.response", {
      bot: bot.name,
      runId: this.env.RUN_ID,
      finishReason: result.finishReason,
      textChars: result.text?.length ?? 0,
      steps: result.steps?.length ?? 0,
    });
    const parsed = this.extractJson(result.text ?? "");
    if (!parsed) {
      logEvent("game.outcome.error", {
        bot: bot.name,
        error: "Unable to parse game outcome JSON.",
      });
      return;
    }
    logEvent(GAME_CONFIG.outcome.event ?? "game.outcome", {
      runId: this.env.RUN_ID,
      game: GAME_CONFIG.name,
      ...(parsed as Record<string, unknown>),
    });
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
      const owner = this.resolveCoordinationOwner(
        current,
        update,
        updatedBy,
      );
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

  private resolveCoordinationOwner(
    current: CoordinationItem | undefined,
    update: CoordinationUpdate,
    updatedBy: string,
  ): string {
    const proposedOwner = update.owner?.trim() || updatedBy;
    if (!current?.owner) {
      return proposedOwner;
    }
    if (current.owner === proposedOwner) {
      return current.owner;
    }
    if (current.status === "done" || current.status === "abandoned") {
      return proposedOwner;
    }
    if (this.isExplicitOwnershipHandoff(current, update, updatedBy)) {
      logEvent("coordination.owner.handoff", {
        taskId: current.taskId,
        from: current.owner,
        to: proposedOwner,
        updatedBy,
      });
      return proposedOwner;
    }
    logEvent("coordination.owner.conflict", {
      taskId: current.taskId,
      currentOwner: current.owner,
      proposedOwner,
      updatedBy,
      status: current.status,
      updateType: update.type,
    });
    return current.owner;
  }

  private isExplicitOwnershipHandoff(
    current: CoordinationItem,
    update: CoordinationUpdate,
    updatedBy: string,
  ): boolean {
    if (updatedBy !== current.owner) {
      return false;
    }
    const proposedOwner = update.owner?.trim();
    if (!proposedOwner || proposedOwner === current.owner) {
      return false;
    }
    return /\b(handoff|hand off|transfer|reassign)\b/i.test(update.summary);
  }

  private filterOutgoingCoordination(
    bot: StoredBot,
    updates: CoordinationUpdate[],
  ): CoordinationUpdate[] {
    if (updates.length === 0) {
      return updates;
    }
    const existing = new Map(
      (bot.coordination ?? []).map((item) => [item.taskId, item]),
    );
    return updates.filter((update) => {
      const current = existing.get(update.taskId);
      if (update.type === "request" && current?.status === "done") {
        return false;
      }
      if (
        current &&
        current.owner === (update.owner?.trim() || current.owner) &&
        current.summary === update.summary &&
        current.status === this.statusForUpdate(update.type, current.status)
      ) {
        return false;
      }
      return true;
    });
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
      return previous === "done" ? "done" : "blocked";
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
    coordination: CoordinationUpdate[],
  ): Promise<void> {
    const peers = (bot.knownBots ?? []).filter(
      (peer) => peer.name !== bot.name,
    );
    const targetSet = new Set(
      this.enforceRecipientLimits(bot, recipients, coordination),
    );
    const targets = peers.filter((peer) => targetSet.has(peer.name));
    logEvent("message.broadcast.plan", {
      bot: bot.name,
      requestedRecipients: recipients,
      finalRecipients: targets.map((peer) => peer.name),
      coordinationTypes: coordination.map((update) => update.type),
    });
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
    const sentFingerprints: OutboundFingerprint[] = [];
    await Promise.all(
      targets.map(async (peer) => {
        const fingerprint = this.buildOutboundFingerprint(content, coordination);
        if (this.hasRecentOutboundFingerprint(bot, peer.name, fingerprint)) {
          logEvent("message.broadcast.skip", {
            bot: bot.name,
            reason: "duplicate-outbound",
            to: peer.name,
          });
          return;
        }
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
          sentFingerprints.push({
            recipient: peer.name,
            fingerprint,
            sentAt: new Date().toISOString(),
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
    if (sentFingerprints.length > 0) {
      await this.recordOutboundFingerprints(bot, sentFingerprints);
    }
  }

  private selectCoordinator(peers: BotPeer[], fallback: string): string {
    const names = peers.map((peer) => peer.name).filter(Boolean).sort();
    return names[0] ?? fallback;
  }

  private shouldBotRespond(bot: StoredBot, message: BotMessageInput): boolean {
    const sender = message.botId.trim();
    const peerNames = new Set((bot.knownBots ?? []).map((peer) => peer.name));
    const isPeerSender = peerNames.has(sender);
    const coordinator = bot.coordinator;
    const updates = this.collectCoordinationUpdates(sender, message.content);
    if (!isPeerSender) {
      return true;
    }
    if (sender === coordinator) {
      return true;
    }
    if (
      updates.some(
        (update) =>
          update.type === "request" &&
          (update.owner === bot.name || update.taskId.includes(bot.name.toLowerCase())),
      )
    ) {
      return true;
    }
    if (
      bot.name === coordinator &&
      updates.some((update) => update.type === "complete" || update.type === "report")
    ) {
      return true;
    }
    if (bot.name === coordinator) {
      return true;
    }
    logEvent("brain.skip", {
      bot: bot.name,
      reason: "peer-routing-policy",
      from: sender,
      coordinator,
    });
    return false;
  }

  private normalizeRecipients(
    bot: StoredBot,
    requested: string[],
    fallbackRecipient: string,
    coordination: CoordinationUpdate[],
  ): string[] {
    const peerNames = new Set(
      (bot.knownBots ?? [])
        .map((peer) => peer.name)
        .filter((name) => name && name !== bot.name),
    );
    const requestedValid = requested.filter((name) => peerNames.has(name));
    const requestTargets = new Set(
      coordination
        .filter((update) => update.type === "request")
        .map((update) => this.inferTargetBotName(bot, update)),
    );
    const hasCrossBotRequest = requestTargets.size > 0;
    if (requestedValid.length > 0) {
      if (bot.name !== bot.coordinator && !hasCrossBotRequest) {
        return bot.coordinator && peerNames.has(bot.coordinator)
          ? [bot.coordinator]
          : [requestedValid[0]];
      }
      if (bot.name === bot.coordinator && requestTargets.size > 0) {
        const targeted = requestedValid.filter((name) => requestTargets.has(name));
        if (targeted.length > 0) {
          return targeted.slice(0, 2);
        }
      }
      return requestedValid;
    }
    if (bot.name === bot.coordinator && requestTargets.size > 0) {
      const targeted = Array.from(requestTargets).filter(
        (name): name is string => typeof name === "string" && peerNames.has(name),
      );
      if (targeted.length > 0) {
        return targeted.slice(0, 2);
      }
    }
    if (bot.name !== bot.coordinator && bot.coordinator && peerNames.has(bot.coordinator)) {
      return [bot.coordinator];
    }
    if (fallbackRecipient !== bot.name && peerNames.has(fallbackRecipient)) {
      return [fallbackRecipient];
    }
    const firstPeer = Array.from(peerNames)[0];
    return firstPeer ? [firstPeer] : [];
  }

  private enforceRecipientLimits(
    bot: StoredBot,
    recipients: string[],
    coordination: CoordinationUpdate[],
  ): string[] {
    const unique = Array.from(new Set(recipients)).filter((name) => name !== bot.name);
    if (unique.length <= 1) {
      return unique;
    }
    const hasCrossBotRequest = coordination.some((update) => update.type === "request");
    if (bot.name !== bot.coordinator && !hasCrossBotRequest) {
      return unique.slice(0, 1);
    }
    return unique.slice(0, 2);
  }

  private async refreshBotState(bot: StoredBot): Promise<StoredBot> {
    const latest = await this.getProfile();
    return latest.name === bot.name ? latest : bot;
  }

  private isTriggerSuperseded(bot: StoredBot, trigger: BotMessageInput): boolean {
    if (typeof trigger.timestamp !== "string" || trigger.timestamp.trim().length === 0) {
      return false;
    }
    const triggerTimestampMs = Date.parse(trigger.timestamp);
    if (!Number.isFinite(triggerTimestampMs)) {
      return false;
    }
    return bot.messages.some((message) => {
      if (message.botId === bot.name || this.isPresenceMessage(message.content)) {
        return false;
      }
      const messageTimestampMs = Date.parse(message.timestamp);
      if (!Number.isFinite(messageTimestampMs) || messageTimestampMs <= triggerTimestampMs) {
        return false;
      }
      return true;
    });
  }

  private hasExceededSessionReplyBudget(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): boolean {
    const count = bot.sessionReplyCount ?? 0;
    const max = this.getMaxSessionReplies();
    if (count >= max) {
      return true;
    }
    const reserved = this.getReservedFinalReplies();
    if (reserved <= 0 || count < max - reserved) {
      return false;
    }
    return !this.shouldUseReservedReply(bot, trigger);
  }

  private isBrainCoolingDown(bot: StoredBot): boolean {
    if (!bot.lastBrainAt) {
      return false;
    }
    const lastBrainAtMs = Date.parse(bot.lastBrainAt);
    if (!Number.isFinite(lastBrainAtMs)) {
      return false;
    }
    return Date.now() - lastBrainAtMs < this.getBrainCooldownMs();
  }

  private isBackoffActive(bot: StoredBot): boolean {
    if (!bot.backoffUntil) {
      return false;
    }
    const backoffUntilMs = Date.parse(bot.backoffUntil);
    return Number.isFinite(backoffUntilMs) && Date.now() < backoffUntilMs;
  }

  private async recordBrainReply(
    bot: StoredBot,
    trigger: BotMessageInput,
    coordination: CoordinationUpdate[],
    recipients: string[],
  ): Promise<StoredBot> {
    const countAgainstBudget = this.shouldCountReplyAgainstBudget(
      bot,
      trigger,
      coordination,
      recipients,
    );
    const updated: StoredBot = {
      ...bot,
      sessionReplyCount: countAgainstBudget
        ? Math.min(this.getMaxSessionReplies(), (bot.sessionReplyCount ?? 0) + 1)
        : bot.sessionReplyCount ?? 0,
      lastBrainAt: new Date().toISOString(),
      backoffUntil: undefined,
      recentOutbound: this.pruneRecentOutbound(bot.recentOutbound),
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    if (!countAgainstBudget) {
      logEvent("brain.budget.exempt", {
        bot: bot.name,
        from: trigger.botId,
        recipients,
        coordinationTypes: coordination.map((update) => update.type),
      });
    }
    return updated;
  }

  private async setBackoffUntil(bot: StoredBot, backoffUntil: string): Promise<void> {
    const updated: StoredBot = {
      ...bot,
      backoffUntil,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
  }

  private getBrainCooldownMs(): number {
    return this.readPositiveEnvMs(
      "BRAIN_COOLDOWN_SECONDS",
      DEFAULT_BRAIN_COOLDOWN_MS,
    );
  }

  private getRateLimitBackoffMs(): number {
    return this.readPositiveEnvMs(
      "RATE_LIMIT_BACKOFF_SECONDS",
      DEFAULT_RATE_LIMIT_BACKOFF_MS,
    );
  }

  private getMaxSessionReplies(): number {
    const value = this.readInlineEnvValue("MAX_SESSION_REPLIES");
    if (typeof value !== "string") {
      return DEFAULT_MAX_SESSION_REPLIES;
    }
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_MAX_SESSION_REPLIES;
    }
    return Math.floor(parsed);
  }

  private getReservedFinalReplies(): number {
    const value = this.readInlineEnvValue("RESERVED_FINAL_REPLIES");
    if (typeof value !== "string") {
      return DEFAULT_RESERVED_FINAL_REPLIES;
    }
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_RESERVED_FINAL_REPLIES;
    }
    return Math.floor(parsed);
  }

  private shouldUseReservedReply(bot: StoredBot, trigger: BotMessageInput): boolean {
    const updates = this.collectCoordinationUpdates(trigger.botId, trigger.content);
    if (bot.name === bot.coordinator) {
      return updates.some(
        (update) => update.type === "complete" || update.type === "report",
      );
    }
    return updates.some((update) => update.type === "request");
  }

  private shouldCountReplyAgainstBudget(
    bot: StoredBot,
    trigger: BotMessageInput,
    coordination: CoordinationUpdate[],
    recipients: string[],
  ): boolean {
    if (bot.name !== bot.coordinator) {
      return true;
    }
    if (coordination.some((update) => update.type === "claim" || update.type === "request")) {
      return true;
    }
    if (recipients.length > 1) {
      return true;
    }
    const incomingUpdates = this.collectCoordinationUpdates(
      trigger.botId,
      trigger.content,
    );
    if (incomingUpdates.length === 0) {
      return true;
    }
    const onlyIncomingStatus = incomingUpdates.every(
      (update) => update.type === "report" || update.type === "complete",
    );
    const onlyOutgoingStatus =
      coordination.length > 0 &&
      coordination.every(
        (update) => update.type === "report" || update.type === "complete",
      );
    if (onlyIncomingStatus && (onlyOutgoingStatus || recipients.length <= 1)) {
      return false;
    }
    return true;
  }

  private inferTargetBotName(
    bot: StoredBot,
    update: CoordinationUpdate,
  ): string | undefined {
    const peers = new Set(
      (bot.knownBots ?? [])
        .map((peer) => peer.name)
        .filter((name) => name && name !== bot.name),
    );
    const owner = update.owner?.trim();
    if (owner && peers.has(owner)) {
      return owner;
    }
    const lowerSummary = update.summary.toLowerCase();
    for (const peer of peers) {
      if (lowerSummary.includes(peer.toLowerCase())) {
        return peer;
      }
    }
    const lowerTaskId = update.taskId.toLowerCase();
    for (const peer of peers) {
      if (lowerTaskId.includes(peer.toLowerCase())) {
        return peer;
      }
    }
    return undefined;
  }

  private buildOutboundFingerprint(
    content: string,
    coordination: CoordinationUpdate[],
  ): string {
    const normalizedMessage = this.stripCoordinationPayload(content)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const normalizedCoordination = coordination
      .map((update) =>
        [
          update.type,
          update.taskId.trim().toLowerCase(),
          (update.owner ?? "").trim().toLowerCase(),
          update.summary.trim().toLowerCase().replace(/\s+/g, " "),
        ].join("|"),
      )
      .sort()
      .join("||");
    return `${normalizedMessage}@@${normalizedCoordination}`;
  }

  private pruneRecentOutbound(
    entries: OutboundFingerprint[] | undefined,
  ): OutboundFingerprint[] {
    if (!Array.isArray(entries) || entries.length === 0) {
      return [];
    }
    const cutoff = Date.now() - OUTBOUND_DEDUPE_WINDOW_MS;
    return entries.filter((entry) => {
      const sentAtMs = Date.parse(entry.sentAt);
      return Number.isFinite(sentAtMs) && sentAtMs >= cutoff;
    });
  }

  private hasRecentOutboundFingerprint(
    bot: StoredBot,
    recipient: string,
    fingerprint: string,
  ): boolean {
    return this.pruneRecentOutbound(bot.recentOutbound).some(
      (entry) =>
        entry.recipient === recipient && entry.fingerprint === fingerprint,
    );
  }

  private async recordOutboundFingerprints(
    bot: StoredBot,
    entries: OutboundFingerprint[],
  ): Promise<void> {
    const updated: StoredBot = {
      ...bot,
      recentOutbound: this.pruneRecentOutbound([
        ...(bot.recentOutbound ?? []),
        ...entries,
      ]),
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
  }

  private readPositiveEnvMs(name: string, fallbackMs: number): number {
    const value = this.readInlineEnvValue(name);
    if (typeof value !== "string") {
      return fallbackMs;
    }
    const seconds = Number(value.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return fallbackMs;
    }
    return seconds * 1000;
  }

  private isRateLimitError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    const normalized = message.toLowerCase();
    return (
      normalized.includes("rate limit") ||
      normalized.includes("429") ||
      normalized.includes("tpm") ||
      normalized.includes("rpm")
    );
  }
}
