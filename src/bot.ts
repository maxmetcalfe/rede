import { DurableObject } from "cloudflare:workers";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import botDefinitions from "../bots.json";
import gameConfigRaw from "../game.json";
import {
  RuntimeRulesConfig,
} from "./rules";
import {
  buildScenarioContext,
  getScenarioName,
  ScenarioDurableObject,
} from "./scenario";
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
  isCoordinator?: boolean;
  /**
   * Number of seconds the bot should wait before acting.
   */
  speed?: number;
};

export type GameConfig = {
  enabled?: boolean;
  name?: string;
  publicContext?: string;
  runtimeRules?: RuntimeRulesConfig;
  outcome?: {
    event?: string;
    prompt: string;
  };
};

export type BotPeer = {
  name: string;
  botUrl: string;
  prompt?: string;
  isCoordinator?: boolean;
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
   * Timestamp of the most recent inbound trigger that has already been handled.
   */
  lastHandledIncomingAt?: string;
  /**
   * Timestamp of the inbound trigger currently being processed by the runtime.
   */
  inFlightTriggerAt?: string;
  /**
   * Retry count for the currently active inbound trigger.
   */
  triggerRetryCount?: number;
  /**
   * Timestamp until which the bot should suppress new model calls after rate limits.
   */
  backoffUntil?: string;
  /**
   * Most recent runtime/model error observed while handling a trigger.
   */
  lastModelError?: string;
  /**
   * Timestamp of the most recent runtime/model error.
   */
  lastModelErrorAt?: string;
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
const BRAIN_MODEL = "gpt-4o";
const DEFAULT_SESSION_KILL_AFTER_MS = 120_000;
const DEFAULT_BRAIN_COOLDOWN_MS = 4_000;
const DEFAULT_MAX_SESSION_REPLIES = 6;
const DEFAULT_RESERVED_FINAL_REPLIES = 1;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;
const DEFAULT_TRANSIENT_MODEL_BACKOFF_MS = 5_000;
const MAX_TRANSIENT_MODEL_RETRIES = 2;
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 90_000;
const WEB_FETCH_TIMEOUT_MS = 10_000;
const WEB_FETCH_MAX_CHARS = 20_000;
const DEFAULT_BRAIN_RECOVERY_DELAY_MS = 2_000;
const DEFAULT_IDLE_TURN_PROBE_MS = 15_000;
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
  private static readonly BRAIN_ALARM_KEY = "brain-alarm";

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
      lastHandledIncomingAt: persisted?.lastHandledIncomingAt,
      inFlightTriggerAt: persisted?.inFlightTriggerAt,
      triggerRetryCount: persisted?.triggerRetryCount ?? 0,
      backoffUntil: persisted?.backoffUntil,
      lastModelError: persisted?.lastModelError,
      lastModelErrorAt: persisted?.lastModelErrorAt,
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
        lastHandledIncomingAt: bot.lastHandledIncomingAt,
        inFlightTriggerAt: bot.inFlightTriggerAt,
        triggerRetryCount: bot.triggerRetryCount ?? 0,
        backoffUntil: bot.backoffUntil,
        lastModelError: bot.lastModelError,
        lastModelErrorAt: bot.lastModelErrorAt,
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
      triggerRetryCount:
        shouldStartNewSession && !isPresenceMessage ? 0 : bot.triggerRetryCount ?? 0,
      backoffUntil:
        shouldStartNewSession && !isPresenceMessage ? undefined : bot.backoffUntil,
      lastModelError:
        shouldStartNewSession && !isPresenceMessage ? undefined : bot.lastModelError,
      lastModelErrorAt:
        shouldStartNewSession && !isPresenceMessage ? undefined : bot.lastModelErrorAt,
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
    await this.scheduleBrainAlarm(this.getBrainRecoveryDelayMs());
    this.ctx.waitUntil(this.enqueueBrainRun(updated, message));
    return updated;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete(BotDurableObject.BRAIN_ALARM_KEY);
    let latest = await this.getProfile().catch(() => undefined);
    if (!latest || latest.sessionStopped || this.hasConversationExpired(latest)) {
      return;
    }
    if (this.hasStaleInFlightTrigger(latest)) {
      latest = await this.clearStaleInFlightTrigger(latest);
      logEvent("brain.skip", {
        bot: latest.name,
        reason: "stale-inflight-trigger",
        triggerTimestamp: latest.lastHandledIncomingAt ?? latest.inFlightTriggerAt,
      });
    }
    const trigger = this.findPendingBrainTrigger(latest);
    if (!trigger) {
      const selfHealTrigger = await this.buildIdleSelfHealTrigger(latest);
      if (selfHealTrigger) {
        logEvent("brain.alarm.self-heal", {
          bot: latest.name,
          triggerFrom: selfHealTrigger.botId,
          timestamp: selfHealTrigger.timestamp,
        });
        await this.enqueueBrainRun(latest, selfHealTrigger);
        await this.scheduleBrainAlarm(this.getBrainCooldownMs());
        return;
      }
      if (typeof latest.inFlightTriggerAt === "string" && latest.inFlightTriggerAt.trim().length > 0) {
        await this.scheduleBrainAlarm(this.getLlmRequestTimeoutMs() + this.getBrainRecoveryDelayMs());
      } else if (GAME_CONFIG.runtimeRules && latest.sessionStartedAt) {
        await this.scheduleBrainAlarm(this.getIdleTurnProbeMs());
      }
      return;
    }
    logEvent("brain.alarm.resume", {
      bot: latest.name,
      from: trigger.botId,
      timestamp: trigger.timestamp,
    });
    await this.enqueueBrainRun(latest, trigger);
    const stillPending = await this.getProfile().then((bot) => this.findPendingBrainTrigger(bot));
    if (stillPending) {
      await this.scheduleBrainAlarm(this.getBrainCooldownMs());
    }
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

  private async scheduleBrainAlarm(delayMs = 0): Promise<void> {
    const scheduledFor = Date.now() + Math.max(0, delayMs);
    const current = await this.ctx.storage.get<number>(
      BotDurableObject.BRAIN_ALARM_KEY,
    );
    if (typeof current === "number" && current >= Date.now() && current <= scheduledFor) {
      return;
    }
    await this.ctx.storage.put(BotDurableObject.BRAIN_ALARM_KEY, scheduledFor);
    await this.ctx.storage.setAlarm(scheduledFor);
  }

  private findPendingBrainTrigger(bot: StoredBot): BotMessageInput | undefined {
    const latestIncoming = [...bot.messages]
      .reverse()
      .find(
        (message) =>
          message.botId !== bot.name && !this.isPresenceMessage(message.content),
      );
    if (!latestIncoming) {
      return undefined;
    }
    const incomingTimestampMs = Date.parse(latestIncoming.timestamp);
    if (!Number.isFinite(incomingTimestampMs)) {
      return {
        botId: latestIncoming.botId,
        content: latestIncoming.content,
        timestamp: latestIncoming.timestamp,
      };
    }
    const lastHandledIncomingAtMs =
      typeof bot.lastHandledIncomingAt === "string"
        ? Date.parse(bot.lastHandledIncomingAt)
        : Number.NaN;
    const inFlightTriggerAtMs =
      typeof bot.inFlightTriggerAt === "string"
        ? Date.parse(bot.inFlightTriggerAt)
        : Number.NaN;
    const latestProcessedTriggerAtMs = Math.max(
      Number.isFinite(lastHandledIncomingAtMs) ? lastHandledIncomingAtMs : Number.NEGATIVE_INFINITY,
      Number.isFinite(inFlightTriggerAtMs) ? inFlightTriggerAtMs : Number.NEGATIVE_INFINITY,
    );
    if (
      Number.isFinite(latestProcessedTriggerAtMs) &&
      latestProcessedTriggerAtMs >= incomingTimestampMs
    ) {
      return undefined;
    }
    return {
      botId: latestIncoming.botId,
      content: latestIncoming.content,
      timestamp: latestIncoming.timestamp,
    };
  }

  private async buildIdleSelfHealTrigger(
    bot: StoredBot,
  ): Promise<BotMessageInput | undefined> {
    if (!GAME_CONFIG.runtimeRules) {
      return undefined;
    }
    if (this.isBackoffActive(bot)) {
      return undefined;
    }
    if (typeof bot.inFlightTriggerAt === "string" && bot.inFlightTriggerAt.trim().length > 0) {
      return undefined;
    }
    const lastRelevantActivityMs = this.getLastRelevantActivityMs(bot);
    if (
      Number.isFinite(lastRelevantActivityMs) &&
      Date.now() - lastRelevantActivityMs < this.getIdleTurnProbeMs()
    ) {
      return undefined;
    }
    const publicState = await this.getScenarioPublicState(bot);
    const legalActions = this.extractScenarioLegalActions(publicState);
    if (legalActions.length === 0) {
      return undefined;
    }
    return {
      botId: "runtime",
      content: "Runtime self-heal turn probe.",
      timestamp: new Date().toISOString(),
    };
  }

  private getLastRelevantActivityMs(bot: StoredBot): number {
    const candidates = [
      bot.lastBrainAt,
      bot.lastHandledIncomingAt,
      bot.sessionStartedAt,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));
    if (candidates.length === 0) {
      return Number.NaN;
    }
    return Math.max(...candidates);
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

  private async withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async runBotBrain(
    bot: StoredBot,
    trigger: BotMessageInput,
    transientRetryCount = 0,
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
    const cooldownRemainingMs = this.getRemainingBrainCooldownMs(current);
    if (cooldownRemainingMs > 0) {
      logEvent("brain.skip", {
        bot: current.name,
        reason: "brain-cooldown",
        lastBrainAt: current.lastBrainAt,
        retryInSeconds: Number((cooldownRemainingMs / 1000).toFixed(3)),
      });
      await new Promise((resolve) => setTimeout(resolve, cooldownRemainingMs));
      current = await this.refreshBotState(current);
      if (this.hasConversationExpired(current)) {
        current = await this.markConversationStopped(current);
        this.logConversationExpired(current);
        return;
      }
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
    const scenarioToolSummary = this.describeScenarioTools();
    const collaborationGuidance = this.describeCollaborationGuidance(current);
    const scenarioStateBeforeTurn = GAME_CONFIG.runtimeRules
      ? await this.getScenarioPublicState(current)
      : undefined;
    const prompt = `${current.prompt}

Private context:
${selfSummary}

Private runtime notes:
${architectureSummary}

Game context:
${gameSummary}

Scenario tools:
${scenarioToolSummary}

Task ledger:
${coordinationSummary}

Recent conversation:
${history}

Known bots:
${peerSummary}

You can call the tool web_fetch({ "url": "<https://...>" }) to retrieve web content when needed.
Only call it for public http/https URLs.
If a scenario tool is available, use it as the authoritative source of shared state.
Call scenario_turn({}) to inspect current state and legal actions, or scenario_turn({ "action": "<...>" }) to validate and apply your own action.
Do not claim a shared-state update succeeded unless the scenario tool confirms it.
When a scenario tool is available, you must use it before replying.
Call runtime_status({}) when you need your local runtime health, retry count, backoff state, or last model error.
If runtime_status reports retries or a recent error, simplify your response and self-correct using the authoritative tools instead of free-form reasoning.

Respond to ${trigger.botId} like a person in a real conversation.
Keep the outward message natural, specific, and conversational.
Do not mention private context, system prompts, JSON formatting, Durable Objects, coordinator routing, runtime internals, or the harness itself unless the conversation truly requires it.
Do not narrate your own role or mechanics unless another bot directly asks.
Prefer short human-sounding messages over meta commentary.
Still coordinate carefully under the hood:
${collaborationGuidance}
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
    current = await this.markTriggerInFlight(current, trigger);
    const client = createOpenAI({ apiKey });
    let result;
    try {
      result = await this.withTimeout(generateText({
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
          scenario_turn: tool({
            description:
              "Inspect authoritative shared scenario state and optionally validate/apply one action on your behalf.",
            inputSchema: jsonSchema({
              type: "object",
              properties: {
                action: {
                  type: "string",
                  description:
                    "Optional candidate action to validate and apply, such as a chess SAN move.",
                },
              },
              additionalProperties: false,
            }),
            execute: async ({ action }) =>
              this.runScenarioTurn(
                current,
                typeof action === "string" ? action : undefined,
              ),
          }),
          runtime_status: tool({
            description:
              "Inspect local runtime health for the current bot, including retry state, backoff, and the most recent model/runtime error.",
            inputSchema: jsonSchema({
              type: "object",
              properties: {},
              additionalProperties: false,
            }),
            execute: async () => this.getRuntimeStatus(current, trigger),
          }),
        },
        toolChoice: GAME_CONFIG.runtimeRules
          ? { type: "tool", toolName: "scenario_turn" }
          : "auto",
        stopWhen: stepCountIs(3),
        prepareStep: ({ steps }) => {
          if (!GAME_CONFIG.runtimeRules) {
            return undefined;
          }
          if (steps.length === 0) {
            return {
              activeTools: ["scenario_turn", "runtime_status"],
              toolChoice: { type: "tool", toolName: "scenario_turn" },
            };
          }
          return {
            activeTools: ["scenario_turn", "runtime_status", "web_fetch"],
            toolChoice: "auto",
          };
        },
      }), this.getLlmRequestTimeoutMs(), "LLM request");
    } catch (error) {
      if (this.isRateLimitError(error)) {
        current = await this.clearInFlightTrigger(current, trigger);
        current = await this.recordRuntimeFailure(
          current,
          trigger,
          error,
          transientRetryCount + 1,
        );
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
      if (
        this.isTransientModelError(error) &&
        transientRetryCount < MAX_TRANSIENT_MODEL_RETRIES
      ) {
        current = await this.clearInFlightTrigger(current, trigger);
        current = await this.recordRuntimeFailure(
          current,
          trigger,
          error,
          transientRetryCount + 1,
        );
        const backoffMs = this.getTransientModelBackoffMs();
        await this.setBackoffUntil(
          current,
          new Date(Date.now() + backoffMs).toISOString(),
        );
        logEvent("brain.skip", {
          bot: current.name,
          reason: "transient-model-error",
          retryInSeconds: backoffMs / 1000,
          retryAttempt: transientRetryCount + 1,
          error:
            error instanceof Error
              ? error.message
              : String(error ?? "unknown error"),
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
        return this.runBotBrain(current, trigger, transientRetryCount + 1);
      }
      await this.clearInFlightTrigger(current, trigger);
      throw error;
    }
    current = await this.clearInFlightTrigger(current, trigger);
    logEvent("llm.response", {
      bot: current.name,
      model: BRAIN_MODEL,
      finishReason: result.finishReason,
      textChars: result.text?.length ?? 0,
      toolCalls: result.toolCalls?.length ?? 0,
      toolResults: result.toolResults?.length ?? 0,
      steps: result.steps?.length ?? 0,
    });
    const usedScenarioTool = (result.toolCalls ?? []).some(
      (call) => call.toolName === "scenario_turn",
    );
    current = await this.refreshBotState(current);
    current = await this.clearRuntimeFailure(current);
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
      const recoveredMove = await this.recoverScenarioMove(current, trigger);
      if (recoveredMove) {
        logEvent("scenario.action.applied", {
          bot: current.name,
          action: recoveredMove.move,
          via: recoveredMove.via,
        });
        return this.emitScenarioMove(current, trigger, recoveredMove.move);
      }
      await this.recordHandledTrigger(current, trigger);
      logEvent("brain.skip", { bot: current.name, reason: "empty-reply" });
      return;
    }
    let { message, recipients, coordination } = this.parseBrainResponse(
      reply,
      current,
      trigger.botId,
    );
    if (!message) {
      const recoveredMove = await this.recoverScenarioMove(current, trigger, {
        rawReply: reply,
      });
      if (recoveredMove) {
        logEvent("scenario.action.applied", {
          bot: current.name,
          action: recoveredMove.move,
          via: recoveredMove.via,
        });
        return this.emitScenarioMove(current, trigger, recoveredMove.move);
      }
      await this.recordHandledTrigger(current, trigger);
      logEvent("brain.skip", {
        bot: current.name,
        reason:
          coordination.length > 0
            ? "coordination-only-reply"
            : "unparsable-reply",
        rawPreview: reply.slice(0, 240),
      });
      return;
    }
    if (GAME_CONFIG.runtimeRules && !usedScenarioTool) {
      const publicState = await this.getScenarioPublicState(current);
      logEvent("scenario.state.inspect", {
        bot: current.name,
        via: "runtime-fallback",
        state: this.extractScenarioStateSummary(publicState),
      });
      const validated = await this.applyScenarioAction(current, message);
      if (!this.isScenarioActionAccepted(validated)) {
        const recoveredMove = await this.recoverScenarioMove(current, trigger, {
          publicState,
          rawReply: reply,
        });
        if (recoveredMove) {
          logEvent("scenario.action.applied", {
            bot: current.name,
            action: recoveredMove.move,
            via: recoveredMove.via,
          });
          return this.emitScenarioMove(current, trigger, recoveredMove.move);
        }
        if (
          this.didScenarioAdvanceWithAction(
            current,
            trigger,
            scenarioStateBeforeTurn,
            publicState,
            message,
          )
        ) {
          logEvent("scenario.action.applied", {
            bot: current.name,
            action: message,
            via: "runtime-reconciled-existing-state",
          });
        } else if (this.isScenarioActionAlreadyApplied(current, trigger, publicState, message)) {
          await this.recordHandledTrigger(current, trigger);
          logEvent("brain.skip", {
            bot: current.name,
            reason: "scenario-action-already-broadcast",
            action: message,
          });
          return;
        } else {
        logEvent("brain.skip", {
          bot: current.name,
          reason: "scenario-action-rejected",
          attemptedAction: message,
          error: this.getScenarioActionError(validated),
          state: this.extractScenarioStateSummary(validated),
        });
        return;
        }
      } else {
        const acceptedAction =
          typeof validated.action === "string" && validated.action.trim().length > 0
            ? validated.action.trim()
            : message;
        message = acceptedAction;
        recipients = this.normalizeRecipients(
          current,
          recipients,
          trigger.botId,
          coordination,
          acceptedAction,
        );
        logEvent("scenario.action.applied", {
          bot: current.name,
          action: acceptedAction,
          via: "runtime-fallback",
        });
      }
      recipients = this.normalizeRecipients(
        current,
        recipients,
        trigger.botId,
        coordination,
        message,
      );
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
      message,
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

  private describeScenarioTools(): string {
    if (!GAME_CONFIG.runtimeRules) {
      return [
        "runtime_status({}) returns local runtime health such as trigger retry count, backoff, and last model error",
        "No shared scenario tools configured for this run.",
      ].join("\n");
    }
    return [
      `shared engine: ${GAME_CONFIG.runtimeRules.engine}`,
      "scenario_turn({}) returns the authoritative shared state",
      'scenario_turn({ "action": "<...>" }) validates and applies one action atomically',
      "treat tool results as source of truth for turn order, legality, and terminal state",
      "runtime_status({}) returns local runtime health such as trigger retry count, backoff, and last model error",
    ].join("\n");
  }

  private describeCollaborationGuidance(bot: StoredBot): string {
    if (GAME_CONFIG.runtimeRules) {
      if (this.isChessRuntime()) {
        return [
          "- shared state is managed by the scenario tool, not by conversational memory",
          "- call runtime_status() if you are recovering from an error, retry, timeout, or confusing local state",
          "- if runtime_status shows retries or a recent model error, simplify: inspect scenario_turn() and respond with one legal move only",
          "- if it is your turn, produce exactly one legal chess move and nothing else",
          "- if it is not your turn, do not send a move",
          "- do not include status chatter, explanations, or extra coordination with chess moves",
        ].join("\n");
      }
      return [
        "- shared state is managed by the scenario tools, not by conversational memory",
        "- call runtime_status() if you are recovering from an error, retry, timeout, or confusing local state",
        "- use scenario_turn before asserting turn order or board state",
        "- use scenario_turn with an action to validate and apply your own action before telling another bot it happened",
        "- claim concrete tasks instead of vaguely acknowledging",
        "- if you finish work, record completion",
        "- if you need another bot to do something, send a request to that bot",
        "- do not broadcast to the whole swarm unless coordination actually requires it",
      ].join("\n");
    }
    return [
      `- the run coordinator is ${bot.coordinator ?? "unknown"} and should receive default status updates`,
      "- claim concrete tasks instead of vaguely acknowledging",
      "- avoid duplicating a task already owned by another bot unless you are blocked or asked to help",
      "- if you are not the coordinator, send normal progress reports back to the coordinator",
      "- if you are taking work, record it as a claim",
      "- if you finish work, record completion",
      "- if you need another bot to do something, send a request to that bot",
      "- do not broadcast to the whole swarm unless coordination actually requires it",
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
    const parsedMessage = this.extractParsedMessage(parsed);
    if (parsed) {
      const requested = Array.isArray(parsed?.recipients)
        ? parsed.recipients.filter((value) => typeof value === "string")
        : [];
      const coordination = this.isChessRuntime()
        ? []
        : this.normalizeCoordinationUpdates(parsed?.coordination, bot.name);
      const filtered = requested.filter(
        (name) => name !== bot.name && peerNames.has(name),
      );
      return this.stabilizeCoordinatorRelay(bot, {
        message: parsedMessage,
        recipients: this.normalizeRecipients(
          bot,
          filtered,
          fallbackRecipient,
          coordination,
          parsedMessage,
        ),
        coordination,
      });
    }
    const fallbackMessage = this.extractFallbackMessage(raw);
    const coordination = this.isChessRuntime()
      ? []
      : this.inferCoordinationUpdates(bot.name, fallbackMessage);
    return this.stabilizeCoordinatorRelay(bot, {
      message: fallbackMessage,
      recipients: this.normalizeRecipients(
        bot,
        [],
        fallbackRecipient,
        coordination,
        fallbackMessage,
      ),
      coordination,
    });
  }

  private extractParsedMessage(
    parsed: { message?: string; recipients?: unknown; coordination?: unknown } | null,
  ): string {
    if (!parsed || typeof parsed !== "object") {
      return "";
    }
    const candidates = [
      parsed.message,
      (parsed as { move?: unknown }).move,
      (parsed as { action?: unknown }).action,
      (parsed as { reply?: unknown }).reply,
      (parsed as { content?: unknown }).content,
      (parsed as { text?: unknown }).text,
      (parsed as { output?: unknown }).output,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = this.extractFallbackMessage(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return "";
  }

  private extractFallbackMessage(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    const withoutFences = trimmed
      .replace(/^```[a-zA-Z0-9_-]*\s*/g, "")
      .replace(/\s*```$/g, "")
      .trim();
    const firstNonEmptyLine = withoutFences
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstNonEmptyLine) {
      return "";
    }
    const withoutBullet = firstNonEmptyLine.replace(/^[-*]\s+/, "").trim();
    const withoutLabel = withoutBullet.replace(
      /^(message|move|action|reply|content|text)\s*:\s*/i,
      "",
    );
    return withoutLabel
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1")
      .trim();
  }

  private stabilizeCoordinatorRelay(
    bot: StoredBot,
    reply: { message: string; recipients: string[]; coordination: CoordinationUpdate[] },
  ): { message: string; recipients: string[]; coordination: CoordinationUpdate[] } {
    if (bot.name !== bot.coordinator) {
      return reply;
    }
    const inferredRecipient = this.inferTurnRecipient(bot, reply.message);
    if (!inferredRecipient) {
      return reply;
    }
    const recipients = reply.recipients.includes(inferredRecipient)
      ? reply.recipients
      : [inferredRecipient];
    const coordination = reply.coordination.some(
      (update) => update.type === "report" || update.type === "request",
    )
      ? reply.coordination
      : [this.buildCoordinatorRelayReport(bot, inferredRecipient, reply.message)];
    return {
      ...reply,
      recipients,
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
    if (this.isChessRuntime()) {
      return [];
    }
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
    if (this.isChessRuntime()) {
      return message;
    }
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
          const timestamp = new Date().toISOString();
          const response = await fetch(messageEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              to: peer.name,
              content,
              timestamp,
            }),
          });
          if (!response.ok) {
            logEvent("message.broadcast.error", {
              from: bot.name,
              to: peer.name,
              status: response.status,
            });
            return;
          }
          logEvent("message.send", {
            from: bot.name,
            to: peer.name,
            content,
            timestamp,
          });
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
    const explicit = peers.find((peer) => peer.isCoordinator && peer.name);
    if (explicit?.name) {
      return explicit.name;
    }
    const names = peers.map((peer) => peer.name).filter(Boolean).sort();
    return names[0] ?? fallback;
  }

  private shouldBotRespond(bot: StoredBot, message: BotMessageInput): boolean {
    if (GAME_CONFIG.runtimeRules) {
      return true;
    }
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
    message: string,
  ): string[] {
    if (GAME_CONFIG.runtimeRules) {
      const peerNames = new Set(
        (bot.knownBots ?? [])
          .map((peer) => peer.name)
          .filter((name) => name && name !== bot.name),
      );
      const requestedValid = requested.filter((name) => peerNames.has(name));
      if (requestedValid.length > 0) {
        return requestedValid.slice(0, 2);
      }
      if (fallbackRecipient !== bot.name && peerNames.has(fallbackRecipient)) {
        return [fallbackRecipient];
      }
      const firstPeer = Array.from(peerNames)[0];
      return firstPeer ? [firstPeer] : [];
    }
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
    if (bot.name === bot.coordinator) {
      const inferredTurnRecipient = this.inferTurnRecipient(bot, message);
      if (inferredTurnRecipient && peerNames.has(inferredTurnRecipient)) {
        return [inferredTurnRecipient];
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

  private inferTurnRecipient(
    bot: StoredBot,
    message: string,
  ): string | undefined {
    const normalized = message.toLowerCase();
    if (/\bwhite to move\b/.test(normalized)) {
      return this.findPeerByRoleHint(bot, "white") ?? this.findPeerByName(bot, "A");
    }
    if (/\bblack to move\b/.test(normalized)) {
      return this.findPeerByRoleHint(bot, "black") ?? this.findPeerByName(bot, "B");
    }
    return undefined;
  }

  private findPeerByRoleHint(bot: StoredBot, role: "white" | "black"): string | undefined {
    const peers = (bot.knownBots ?? []).filter((peer) => peer.name !== bot.name);
    const match = peers.find((peer) =>
      (peer.prompt ?? "").toLowerCase().includes(`playing ${role}`),
    );
    return match?.name;
  }

  private findPeerByName(bot: StoredBot, name: string): string | undefined {
    const peers = new Set(
      (bot.knownBots ?? [])
        .map((peer) => peer.name)
        .filter((peerName) => peerName && peerName !== bot.name),
    );
    return peers.has(name) ? name : undefined;
  }

  private buildCoordinatorRelayReport(
    bot: StoredBot,
    recipient: string,
    message: string,
  ): CoordinationUpdate {
    const lastMove = message.match(/\blast move:\s*([^.\n]+)/i)?.[1]?.trim();
    const sideToMove = /\bwhite to move\b/i.test(message) ? "White" : "Black";
    const summary = lastMove
      ? `${lastMove} processed. ${sideToMove} to move.`
      : `${sideToMove} to move.`;
    return {
      type: "report",
      taskId: `update-board-and-pass-to-${recipient}`,
      summary,
      owner: bot.name,
    };
  }

  private enforceRecipientLimits(
    bot: StoredBot,
    recipients: string[],
    coordination: CoordinationUpdate[],
  ): string[] {
    const unique = Array.from(new Set(recipients)).filter((name) => name !== bot.name);
    if (GAME_CONFIG.runtimeRules) {
      return unique.slice(0, 2);
    }
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

  private getScenarioStub():
    | DurableObjectStub<ScenarioDurableObject>
    | undefined {
    if (!GAME_CONFIG.runtimeRules) {
      return undefined;
    }
    return this.env.SCENARIOS.getByName(getScenarioName(this.env));
  }

  private buildRuntimeRulesContext(bot: StoredBot) {
    return buildScenarioContext(
      (bot.knownBots ?? []).map((peer) => ({
        name: peer.name,
        prompt: peer.prompt,
      })),
      this.env.RUN_ID,
    );
  }

  private async ensureScenarioInitialized(bot: StoredBot): Promise<void> {
    const stub = this.getScenarioStub();
    if (!stub || !GAME_CONFIG.runtimeRules) {
      return;
    }
    await stub.ensureInitialized({
      config: GAME_CONFIG.runtimeRules,
      context: this.buildRuntimeRulesContext(bot),
    });
  }

  private async getScenarioPublicState(bot: StoredBot): Promise<unknown> {
    const stub = this.getScenarioStub();
    if (!stub || !GAME_CONFIG.runtimeRules) {
      return {
        ok: false,
        error: "No shared scenario engine is configured for this run.",
      };
    }
    await this.ensureScenarioInitialized(bot);
    return stub.getPublicState({
      actor: bot.name,
      config: GAME_CONFIG.runtimeRules,
      context: this.buildRuntimeRulesContext(bot),
    });
  }

  private async applyScenarioAction(
    bot: StoredBot,
    action: string,
  ): Promise<unknown> {
    const stub = this.getScenarioStub();
    if (!stub || !GAME_CONFIG.runtimeRules) {
      return {
        ok: false,
        error: "No shared scenario engine is configured for this run.",
      };
    }
    await this.ensureScenarioInitialized(bot);
    return stub.applyAction({
      actor: bot.name,
      action: action.trim(),
      config: GAME_CONFIG.runtimeRules,
      context: this.buildRuntimeRulesContext(bot),
    });
  }

  private async runScenarioTurn(
    bot: StoredBot,
    action?: string,
  ): Promise<unknown> {
    if (typeof action === "string" && action.trim().length > 0) {
      return this.applyScenarioAction(bot, action);
    }
    return this.getScenarioPublicState(bot);
  }

  private async getRuntimeStatus(
    bot: StoredBot,
    trigger?: BotMessageInput,
  ): Promise<{
    bot: string;
    model: string;
    trigger?: { from: string; timestamp?: string };
    runtime: {
      inFlightTriggerAt?: string;
      triggerRetryCount: number;
      backoffUntil?: string;
      brainCooldownMsRemaining: number;
      lastBrainAt?: string;
      lastHandledIncomingAt?: string;
      lastModelError?: string;
      lastModelErrorAt?: string;
    };
    scenario?: {
      enabled: boolean;
      engine?: string;
    };
  }> {
    const latest = await this.refreshBotState(bot);
    return {
      bot: latest.name,
      model: BRAIN_MODEL,
      trigger:
        trigger && trigger.botId
          ? {
              from: trigger.botId,
              timestamp: trigger.timestamp,
            }
          : undefined,
      runtime: {
        inFlightTriggerAt: latest.inFlightTriggerAt,
        triggerRetryCount: latest.triggerRetryCount ?? 0,
        backoffUntil: latest.backoffUntil,
        brainCooldownMsRemaining: this.getRemainingBrainCooldownMs(latest),
        lastBrainAt: latest.lastBrainAt,
        lastHandledIncomingAt: latest.lastHandledIncomingAt,
        lastModelError: latest.lastModelError,
        lastModelErrorAt: latest.lastModelErrorAt,
      },
      scenario: GAME_CONFIG.runtimeRules
        ? {
            enabled: true,
            engine: GAME_CONFIG.runtimeRules.engine,
          }
        : {
            enabled: false,
          },
    };
  }

  private isScenarioActionAccepted(
    value: unknown,
  ): value is { ok: true; action?: string } {
    return Boolean(
      value &&
        typeof value === "object" &&
        "ok" in value &&
        (value as { ok?: unknown }).ok === true,
    );
  }

  private getScenarioActionError(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    const error = (value as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  }

  private extractScenarioStateSummary(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || !("state" in value)) {
      if (!value || typeof value !== "object" || !("publicState" in value)) {
        return undefined;
      }
      const publicState = (value as { publicState?: unknown }).publicState;
      if (!publicState || typeof publicState !== "object" || !("state" in publicState)) {
        return undefined;
      }
      return this.extractScenarioStateSummary(publicState);
    }
    const state = (value as { state?: unknown }).state;
    if (!state || typeof state !== "object") {
      return undefined;
    }
    const candidate = state as Record<string, unknown>;
    return {
      fen: candidate.fen,
      sideToMove: candidate.sideToMove,
      moveNumber: candidate.moveNumber,
      status: candidate.status,
      historyLength: Array.isArray(candidate.history) ? candidate.history.length : undefined,
    };
  }

  private didScenarioAdvanceWithAction(
    bot: StoredBot,
    trigger: BotMessageInput,
    before: unknown,
    after: unknown,
    action: string,
  ): boolean {
    const normalizedAction = action.trim();
    if (!normalizedAction || this.hasBotAlreadyBroadcastAction(bot, trigger, normalizedAction)) {
      return false;
    }
    const beforeHistory = this.extractScenarioHistory(before);
    const afterHistory = this.extractScenarioHistory(after);
    if (!beforeHistory || !afterHistory) {
      return false;
    }
    if (afterHistory.length !== beforeHistory.length + 1) {
      return false;
    }
    const beforePrefix = beforeHistory.every((entry, index) => entry === afterHistory[index]);
    if (!beforePrefix) {
      return false;
    }
    const latest = afterHistory[afterHistory.length - 1];
    return latest === normalizedAction;
  }

  private extractScenarioHistory(value: unknown): string[] | undefined {
    if (!value || typeof value !== "object" || !("state" in value)) {
      if (!value || typeof value !== "object" || !("publicState" in value)) {
        return undefined;
      }
      const publicState = (value as { publicState?: unknown }).publicState;
      if (!publicState || typeof publicState !== "object" || !("state" in publicState)) {
        return undefined;
      }
      return this.extractScenarioHistory(publicState);
    }
    const state = (value as { state?: unknown }).state;
    if (!state || typeof state !== "object") {
      return undefined;
    }
    const history = (state as { history?: unknown }).history;
    if (!Array.isArray(history) || history.some((entry) => typeof entry !== "string")) {
      return undefined;
    }
    return history.map((entry) => entry.trim());
  }

  private isScenarioActionAlreadyApplied(
    bot: StoredBot,
    trigger: BotMessageInput,
    value: unknown,
    action: string,
  ): boolean {
    if (!value || typeof value !== "object" || !("state" in value)) {
      return false;
    }
    const state = (value as { state?: unknown }).state;
    if (!state || typeof state !== "object") {
      return false;
    }
    const history = (state as { history?: unknown }).history;
    if (!Array.isArray(history) || history.length === 0) {
      return false;
    }
    const latest = history[history.length - 1];
    if (!(typeof latest === "string" && latest.trim() === action.trim())) {
      return false;
    }
    return this.hasBotAlreadyBroadcastAction(bot, trigger, action);
  }

  private hasBotAlreadyBroadcastAction(
    bot: StoredBot,
    trigger: BotMessageInput,
    action: string,
  ): boolean {
    const normalizedAction = action.trim();
    if (!normalizedAction) {
      return false;
    }
    const triggerTimestampMs =
      typeof trigger.timestamp === "string" ? Date.parse(trigger.timestamp) : Number.NaN;
    return bot.messages.some((message) => {
      if (message.botId !== bot.name) {
        return false;
      }
      const stripped = this.stripCoordinationPayload(message.content).trim();
      if (stripped !== normalizedAction) {
        return false;
      }
      if (!Number.isFinite(triggerTimestampMs)) {
        return true;
      }
      const messageTimestampMs = Date.parse(message.timestamp);
      return Number.isFinite(messageTimestampMs) && messageTimestampMs >= triggerTimestampMs;
    });
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
    return this.getRemainingBrainCooldownMs(bot) > 0;
  }

  private getRemainingBrainCooldownMs(bot: StoredBot): number {
    if (!bot.lastBrainAt) {
      return 0;
    }
    const lastBrainAtMs = Date.parse(bot.lastBrainAt);
    if (!Number.isFinite(lastBrainAtMs)) {
      return 0;
    }
    return Math.max(0, this.getBrainCooldownMs() - (Date.now() - lastBrainAtMs));
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
    const updated = this.buildHandledTriggerState(bot, trigger, {
      sessionReplyCount: countAgainstBudget
        ? Math.min(this.getMaxSessionReplies(), (bot.sessionReplyCount ?? 0) + 1)
        : bot.sessionReplyCount ?? 0,
      lastBrainAt: new Date().toISOString(),
      backoffUntil: undefined,
      recentOutbound: this.pruneRecentOutbound(bot.recentOutbound),
    });
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

  private async emitScenarioMove(
    current: StoredBot,
    trigger: BotMessageInput,
    move: string,
  ): Promise<void> {
    const normalizedRecipients = this.normalizeRecipients(
      current,
      [],
      trigger.botId,
      [],
      move,
    );
    const updated = await this.appendMessage({
      botId: current.name,
      content: move,
    });
    const withBrainMetadata = await this.recordBrainReply(
      updated,
      trigger,
      [],
      normalizedRecipients,
    );
    logEvent("brain.reply", {
      bot: current.name,
      content: move,
      length: move.length,
      recipients: normalizedRecipients,
      coordination: [],
    });
    await this.dispatchMessageActions(
      withBrainMetadata,
      move,
      normalizedRecipients,
      [],
    );
  }

  private async recoverScenarioMove(
    current: StoredBot,
    trigger: BotMessageInput,
    options?: {
      publicState?: unknown;
      rawReply?: string;
    },
  ): Promise<{ move: string; via: string } | undefined> {
    if (!GAME_CONFIG.runtimeRules) {
      return undefined;
    }
    const publicState =
      options?.publicState ?? (await this.getScenarioPublicState(current));
    const legalActions = this.extractScenarioLegalActions(publicState);
    if (legalActions.length === 0) {
      return undefined;
    }
    const rawCandidate = this.extractLegalActionFromRawReply(
      options?.rawReply,
      legalActions,
    );
    if (rawCandidate) {
      return { move: rawCandidate, via: "runtime-raw-legal-action" };
    }
    const repairedMove = await this.tryRepairScenarioMove(
      current,
      trigger,
      publicState,
    );
    if (repairedMove) {
      return { move: repairedMove, via: "runtime-repair" };
    }
    const fallbackMove = this.selectDeterministicLegalAction(
      current,
      trigger,
      legalActions,
    );
    if (!fallbackMove) {
      return undefined;
    }
    return {
      move: fallbackMove,
      via: "runtime-default-legal-action",
    };
  }

  private async tryRepairScenarioMove(
    current: StoredBot,
    trigger: BotMessageInput,
    publicState?: unknown,
  ): Promise<string | undefined> {
    if (!this.isChessRuntime()) {
      return undefined;
    }
    const state = publicState ?? (await this.getScenarioPublicState(current));
    const legalActions = this.extractScenarioLegalActions(state);
    if (legalActions.length === 0) {
      return undefined;
    }
    const apiKey = this.resolveApiKey(current);
    if (!apiKey || apiKey === "[hidden]") {
      return undefined;
    }
    const client = createOpenAI({ apiKey });
    const prompt = [
      current.prompt,
      "",
      `It is your turn. Reply with JSON only: {"message":"<one exact legal move>","recipients":["${trigger.botId}"],"coordination":[]}`,
      `Choose exactly one move from this legal list: ${legalActions.join(", ")}`,
      "Do not explain. Do not report status. Do not include any other text.",
    ].join("\n");
    try {
      const result = await this.withTimeout(
        generateText({
          model: client(BRAIN_MODEL),
          prompt,
        }),
        this.getLlmRequestTimeoutMs(),
        "LLM repair request",
      );
      const parsed = this.parseBrainResponse(
        result.text?.trim() ?? "",
        current,
        trigger.botId,
      );
      const candidate = parsed.message.trim();
      return legalActions.includes(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private extractLegalActionFromRawReply(
    raw: string | undefined,
    legalActions: string[],
  ): string | undefined {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return undefined;
    }
    const candidates = new Set<string>();
    const parsed = this.extractJson(raw);
    const parsedCandidates = [
      parsed?.message,
      (parsed as { move?: unknown } | null)?.move,
      (parsed as { action?: unknown } | null)?.action,
      (parsed as { reply?: unknown } | null)?.reply,
      (parsed as { content?: unknown } | null)?.content,
      (parsed as { text?: unknown } | null)?.text,
      (parsed as { output?: unknown } | null)?.output,
    ];
    for (const candidate of parsedCandidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        candidates.add(this.extractFallbackMessage(candidate));
      }
    }
    candidates.add(this.extractFallbackMessage(raw));
    for (const candidate of candidates) {
      if (legalActions.includes(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private selectDeterministicLegalAction(
    bot: StoredBot,
    trigger: BotMessageInput,
    legalActions: string[],
  ): string | undefined {
    if (legalActions.length === 0) {
      return undefined;
    }
    const seed = `${bot.name}:${trigger.botId}:${trigger.timestamp ?? ""}:${legalActions.length}`;
    let hash = 0;
    for (const char of seed) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return legalActions[hash % legalActions.length];
  }

  private async recordHandledTrigger(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<StoredBot> {
    const updated = this.buildHandledTriggerState(bot, trigger, {
      inFlightTriggerAt: undefined,
      triggerRetryCount: 0,
    });
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    return updated;
  }

  private async markTriggerInFlight(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<StoredBot> {
    if (!(typeof trigger.timestamp === "string" && trigger.timestamp.trim().length > 0)) {
      return bot;
    }
    const updated: StoredBot = {
      ...bot,
      inFlightTriggerAt: trigger.timestamp,
      triggerRetryCount:
        bot.inFlightTriggerAt === trigger.timestamp ? bot.triggerRetryCount ?? 0 : 0,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    await this.scheduleBrainAlarm(this.getLlmRequestTimeoutMs() + this.getBrainRecoveryDelayMs());
    return updated;
  }

  private async clearInFlightTrigger(
    bot: StoredBot,
    trigger: BotMessageInput,
  ): Promise<StoredBot> {
    if (
      bot.inFlightTriggerAt !== trigger.timestamp ||
      !(typeof trigger.timestamp === "string" && trigger.timestamp.trim().length > 0)
    ) {
      return bot;
    }
    const updated: StoredBot = {
      ...bot,
      inFlightTriggerAt: undefined,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    return updated;
  }

  private buildHandledTriggerState(
    bot: StoredBot,
    trigger: BotMessageInput,
    updates: Partial<StoredBot>,
  ): StoredBot {
    return {
      ...bot,
      ...updates,
      inFlightTriggerAt:
        updates.inFlightTriggerAt === undefined ? undefined : updates.inFlightTriggerAt,
      triggerRetryCount:
        typeof updates.triggerRetryCount === "number"
          ? updates.triggerRetryCount
          : bot.triggerRetryCount ?? 0,
      lastHandledIncomingAt:
        typeof trigger.timestamp === "string" && trigger.timestamp.trim().length > 0
          ? trigger.timestamp
          : bot.lastHandledIncomingAt,
    };
  }

  private extractScenarioLegalActions(value: unknown): string[] {
    if (!value || typeof value !== "object") {
      return [];
    }
    const legalActions = (value as { legalActions?: unknown }).legalActions;
    if (!Array.isArray(legalActions)) {
      return [];
    }
    return legalActions.filter((action): action is string => typeof action === "string");
  }

  private isChessRuntime(): boolean {
    return GAME_CONFIG.runtimeRules?.engine === "chess-v1";
  }

  private hasStaleInFlightTrigger(bot: StoredBot): boolean {
    if (!(typeof bot.inFlightTriggerAt === "string" && bot.inFlightTriggerAt.trim().length > 0)) {
      return false;
    }
    const inFlightMs = Date.parse(bot.inFlightTriggerAt);
    if (!Number.isFinite(inFlightMs)) {
      return true;
    }
    return Date.now() - inFlightMs > this.getLlmRequestTimeoutMs() + this.getBrainRecoveryDelayMs();
  }

  private async clearStaleInFlightTrigger(bot: StoredBot): Promise<StoredBot> {
    if (!this.hasStaleInFlightTrigger(bot)) {
      return bot;
    }
    const updated: StoredBot = {
      ...bot,
      inFlightTriggerAt: undefined,
      backoffUntil: undefined,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
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

  private async recordRuntimeFailure(
    bot: StoredBot,
    trigger: BotMessageInput,
    error: unknown,
    retryCount: number,
  ): Promise<StoredBot> {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    const updated: StoredBot = {
      ...bot,
      inFlightTriggerAt: undefined,
      triggerRetryCount: retryCount,
      lastModelError: message,
      lastModelErrorAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    return updated;
  }

  private async clearRuntimeFailure(bot: StoredBot): Promise<StoredBot> {
    if (
      typeof bot.lastModelError === "undefined" &&
      typeof bot.lastModelErrorAt === "undefined" &&
      (bot.triggerRetryCount ?? 0) === 0
    ) {
      return bot;
    }
    const updated: StoredBot = {
      ...bot,
      triggerRetryCount: 0,
      lastModelError: undefined,
      lastModelErrorAt: undefined,
    };
    await this.ctx.storage.put(BOT_STORAGE_KEY, updated);
    this.bot = updated;
    return updated;
  }

  private getBrainCooldownMs(): number {
    return this.readPositiveEnvMs(
      "BRAIN_COOLDOWN_SECONDS",
      DEFAULT_BRAIN_COOLDOWN_MS,
    );
  }

  private getBrainRecoveryDelayMs(): number {
    return Math.max(
      DEFAULT_BRAIN_RECOVERY_DELAY_MS,
      this.getBrainCooldownMs() + 250,
    );
  }

  private getIdleTurnProbeMs(): number {
    return this.readPositiveEnvMs(
      "IDLE_TURN_PROBE_SECONDS",
      DEFAULT_IDLE_TURN_PROBE_MS,
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
        (update) =>
          update.type === "complete" ||
          update.type === "report" ||
          (update.type === "request" &&
            (update.owner === bot.name ||
              update.taskId.includes(bot.name.toLowerCase()))),
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
    const onlyIncomingRequestsForCoordinator = incomingUpdates.every(
      (update) =>
        update.type === "request" &&
        (update.owner === bot.name || update.taskId.includes(bot.name.toLowerCase())),
    );
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
    if (
      onlyIncomingRequestsForCoordinator &&
      recipients.length <= 1 &&
      !coordination.some((update) => update.type === "claim" || update.type === "request")
    ) {
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

  private isTransientModelError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    const normalized = message.toLowerCase();
    return (
      normalized.includes("failed after 3 attempts") ||
      normalized.includes("timed out after") ||
      normalized.includes("an error occurred while processing your request") ||
      normalized.includes("request id req_") ||
      normalized.includes("internal server error") ||
      normalized.includes("server had an error processing your request") ||
      normalized.includes("bad gateway") ||
      normalized.includes("gateway timeout") ||
      normalized.includes("temporarily unavailable") ||
      normalized.includes("503") ||
      normalized.includes("502") ||
      normalized.includes("500")
    );
  }

  private getTransientModelBackoffMs(): number {
    return this.readPositiveEnvMs(
      "TRANSIENT_MODEL_BACKOFF_SECONDS",
      DEFAULT_TRANSIENT_MODEL_BACKOFF_MS,
    );
  }

  private getLlmRequestTimeoutMs(): number {
    return this.readPositiveEnvMs(
      "LLM_REQUEST_TIMEOUT_SECONDS",
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  }
}
