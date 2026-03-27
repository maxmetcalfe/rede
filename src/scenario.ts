import { DurableObject } from "cloudflare:workers";
import gameConfigRaw from "../game.json";
import {
  getRuntimeRulesEngine,
  RuntimeRulesConfig,
  RuntimeRulesContext,
  RuntimeRulesPublicState,
  RuntimeRulesKnownBot,
} from "./rules";

type GameConfig = {
  name?: string;
  runtimeRules?: RuntimeRulesConfig;
};

type ScenarioStoredState = {
  engine: string;
  config: RuntimeRulesConfig;
  state: unknown;
};

type ScenarioInitPayload = {
  config: RuntimeRulesConfig;
  context: RuntimeRulesContext;
};

type ScenarioActionPayload = {
  actor: string;
  action: string;
  config: RuntimeRulesConfig;
  context: RuntimeRulesContext;
};

type ScenarioStatePayload = {
  actor: string;
  config: RuntimeRulesConfig;
  context: RuntimeRulesContext;
};

const GAME_CONFIG = gameConfigRaw as GameConfig;
const SCENARIO_STORAGE_KEY = "scenario";

export class ScenarioDurableObject extends DurableObject<Env> {
  protected readonly ctx: DurableObjectState<{}>;
  protected readonly env: Env;
  private stored?: ScenarioStoredState;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  private async loadStored(): Promise<ScenarioStoredState | undefined> {
    if (!this.stored) {
      this.stored = await this.ctx.storage.get<ScenarioStoredState>(
        SCENARIO_STORAGE_KEY,
      );
    }
    return this.stored;
  }

  private async persistStored(value: ScenarioStoredState): Promise<void> {
    await this.ctx.storage.put(SCENARIO_STORAGE_KEY, value);
    this.stored = value;
  }

  async resetState(): Promise<{ status: "ok" }> {
    await this.ctx.storage.deleteAll();
    this.stored = undefined;
    return { status: "ok" };
  }

  async ensureInitialized(payload: ScenarioInitPayload): Promise<ScenarioStoredState> {
    const existing = await this.loadStored();
    if (existing && existing.engine === payload.config.engine) {
      return existing;
    }
    const engine = getRuntimeRulesEngine(payload.config);
    if (!engine) {
      throw new Error(`Unknown runtime rules engine: ${payload.config.engine}`);
    }
    const stored: ScenarioStoredState = {
      engine: payload.config.engine,
      config: payload.config,
      state: engine.createInitialState(payload.config, payload.context),
    };
    await this.persistStored(stored);
    return stored;
  }

  async getPublicState(
    payload: ScenarioStatePayload,
  ): Promise<RuntimeRulesPublicState> {
    const stored = await this.ensureInitialized({
      config: payload.config,
      context: payload.context,
    });
    const engine = getRuntimeRulesEngine(stored.config);
    if (!engine) {
      throw new Error(`Unknown runtime rules engine: ${stored.config.engine}`);
    }
    return engine.getPublicState(
      stored.state,
      payload.actor,
      stored.config,
      payload.context,
    );
  }

  async applyAction(payload: ScenarioActionPayload): Promise<{
    publicState: RuntimeRulesPublicState;
    ok: boolean;
    action?: string;
    error?: string;
    terminal?: boolean;
    outcome?: {
      winner?: string;
      result: string;
      reason: string;
    };
  }> {
    const stored = await this.ensureInitialized({
      config: payload.config,
      context: payload.context,
    });
    const engine = getRuntimeRulesEngine(stored.config);
    if (!engine) {
      throw new Error(`Unknown runtime rules engine: ${stored.config.engine}`);
    }
    const result = engine.applyAction(
      stored.state,
      payload.actor,
      payload.action,
      stored.config,
      payload.context,
    );
    if (result.ok) {
      await this.persistStored({
        ...stored,
        state: result.state,
      });
    }
    return {
      ok: result.ok,
      action: result.action,
      error: result.error,
      terminal: result.terminal,
      outcome: result.outcome,
      publicState: result.publicState,
    };
  }
}

export function buildScenarioContext(
  knownBots: RuntimeRulesKnownBot[],
  runId?: string,
): RuntimeRulesContext {
  return {
    knownBots,
    runId,
    scenarioName: GAME_CONFIG.name ?? "default-scenario",
  };
}

export function getScenarioName(env: Env): string {
  const parts = [
    GAME_CONFIG.name ?? "default-scenario",
    typeof env.RUN_ID === "string" && env.RUN_ID.trim().length > 0
      ? env.RUN_ID.trim()
      : "default-run",
  ];
  return parts.join(":");
}
