import { Chess } from "chess.js";

export type RuntimeRulesConfig = {
  engine: string;
  options?: Record<string, unknown>;
};

export type RuntimeRulesKnownBot = {
  name: string;
  prompt?: string;
};

export type RuntimeRulesContext = {
  knownBots: RuntimeRulesKnownBot[];
  runId?: string;
  scenarioName: string;
};

export type RuntimeRulesPublicState = {
  state: Record<string, unknown>;
  legalActions?: string[];
};

export type RuntimeRulesActionResult = {
  ok: boolean;
  state: unknown;
  publicState: RuntimeRulesPublicState;
  action?: string;
  error?: string;
  terminal?: boolean;
  outcome?: {
    winner?: string;
    result: string;
    reason: string;
  };
};

export type RuntimeRulesEngine = {
  createInitialState(
    config: RuntimeRulesConfig,
    context: RuntimeRulesContext,
  ): unknown;
  getPublicState(
    state: unknown,
    actor: string,
    config: RuntimeRulesConfig,
    context: RuntimeRulesContext,
  ): RuntimeRulesPublicState;
  applyAction(
    state: unknown,
    actor: string,
    action: string,
    config: RuntimeRulesConfig,
    context: RuntimeRulesContext,
  ): RuntimeRulesActionResult;
};

type ChessScenarioState = {
  fen: string;
  history: string[];
  status: "active" | "checkmate" | "draw";
  winner?: string;
  result?: string;
};

function inferPlayerByPrompt(
  peers: RuntimeRulesKnownBot[],
  role: "white" | "black",
): string | undefined {
  return peers.find((peer) =>
    (peer.prompt ?? "").toLowerCase().includes(`playing ${role}`),
  )?.name;
}

function getChessOptions(
  config: RuntimeRulesConfig,
  context: RuntimeRulesContext,
): { white: string; black: string } {
  const options = config.options ?? {};
  return {
    white:
      (typeof options.white === "string" && options.white.trim()) ||
      inferPlayerByPrompt(context.knownBots, "white") ||
      "A",
    black:
      (typeof options.black === "string" && options.black.trim()) ||
      inferPlayerByPrompt(context.knownBots, "black") ||
      "B",
  };
}

function normalizeChessState(
  state: unknown,
  config: RuntimeRulesConfig,
  context: RuntimeRulesContext,
): ChessScenarioState {
  if (!state || typeof state !== "object") {
    return {
      fen: new Chess().fen(),
      history: [],
      status: "active",
    };
  }
  const candidate = state as Partial<ChessScenarioState>;
  const fallback = new Chess().fen();
  return {
    fen: typeof candidate.fen === "string" ? candidate.fen : fallback,
    history: Array.isArray(candidate.history)
      ? candidate.history.map((value) => String(value))
      : [],
    status:
      candidate.status === "checkmate" || candidate.status === "draw"
        ? candidate.status
        : "active",
    winner:
      typeof candidate.winner === "string" && candidate.winner.trim().length > 0
        ? candidate.winner.trim()
        : undefined,
    result:
      typeof candidate.result === "string" && candidate.result.trim().length > 0
        ? candidate.result.trim()
        : undefined,
  };
}

function buildChessPublicState(
  chess: Chess,
  actor: string,
  config: RuntimeRulesConfig,
  context: RuntimeRulesContext,
  scenarioState: ChessScenarioState,
): RuntimeRulesPublicState {
  const { white, black } = getChessOptions(config, context);
  const actorColor =
    actor === white ? "w" : actor === black ? "b" : undefined;
  const legalActions =
    actorColor && chess.turn() === actorColor && scenarioState.status === "active"
      ? chess.moves()
      : [];
  return {
    state: {
      engine: config.engine,
      fen: chess.fen(),
      moveNumber: chess.moveNumber(),
      sideToMove: chess.turn() === "w" ? "white" : "black",
      history: scenarioState.history,
      status: scenarioState.status,
      result: scenarioState.result,
      winner: scenarioState.winner,
    },
    legalActions,
  };
}

function chessEngine(): RuntimeRulesEngine {
  return {
    createInitialState() {
      return {
        fen: new Chess().fen(),
        history: [],
        status: "active",
      } satisfies ChessScenarioState;
    },
    getPublicState(state, actor, config, context) {
      const scenarioState = normalizeChessState(state, config, context);
      const chess = new Chess(scenarioState.fen);
      return buildChessPublicState(chess, actor, config, context, scenarioState);
    },
    applyAction(state, actor, action, config, context) {
      const scenarioState = normalizeChessState(state, config, context);
      const chess = new Chess(scenarioState.fen);
      const { white, black } = getChessOptions(config, context);
      const actorColor =
        actor === white ? "w" : actor === black ? "b" : undefined;
      if (!actorColor) {
        return {
          ok: false,
          state: scenarioState,
          publicState: buildChessPublicState(
            chess,
            actor,
            config,
            context,
            scenarioState,
          ),
          error: `Actor "${actor}" is not a registered player in this scenario.`,
        };
      }
      if (scenarioState.status !== "active") {
        return {
          ok: false,
          state: scenarioState,
          publicState: buildChessPublicState(
            chess,
            actor,
            config,
            context,
            scenarioState,
          ),
          error: "Scenario already finished.",
          terminal: true,
          outcome:
            scenarioState.result || scenarioState.winner
              ? {
                  winner: scenarioState.winner,
                  result: scenarioState.result ?? "1/2-1/2",
                  reason: scenarioState.status,
                }
              : undefined,
        };
      }
      if (chess.turn() !== actorColor) {
        return {
          ok: false,
          state: scenarioState,
          publicState: buildChessPublicState(
            chess,
            actor,
            config,
            context,
            scenarioState,
          ),
          error: `It is not ${actor}'s turn.`,
        };
      }
      let move;
      try {
        move = chess.move(action);
      } catch {
        move = null;
      }
      if (!move) {
        return {
          ok: false,
          state: scenarioState,
          publicState: buildChessPublicState(
            chess,
            actor,
            config,
            context,
            scenarioState,
          ),
          error: `Illegal action: ${action}`,
        };
      }

      const nextState: ChessScenarioState = {
        fen: chess.fen(),
        history: [...scenarioState.history, move.san],
        status: "active",
      };
      let outcome: RuntimeRulesActionResult["outcome"];
      if (chess.isCheckmate()) {
        nextState.status = "checkmate";
        nextState.winner = actor;
        nextState.result = actorColor === "w" ? "1-0" : "0-1";
        outcome = {
          winner: actor,
          result: nextState.result,
          reason: "checkmate",
        };
      } else if (chess.isDraw() || chess.isStalemate()) {
        nextState.status = "draw";
        nextState.result = "1/2-1/2";
        outcome = {
          result: nextState.result,
          reason: chess.isStalemate() ? "stalemate" : "draw",
        };
      }
      return {
        ok: true,
        state: nextState,
        publicState: buildChessPublicState(
          chess,
          actor,
          config,
          context,
          nextState,
        ),
        action: move.san,
        terminal: nextState.status !== "active",
        outcome,
      };
    },
  };
}

const ENGINES: Record<string, RuntimeRulesEngine> = {
  "chess-v1": chessEngine(),
};

export function getRuntimeRulesEngine(
  config: RuntimeRulesConfig | undefined,
): RuntimeRulesEngine | undefined {
  if (!config?.engine) {
    return undefined;
  }
  return ENGINES[config.engine];
}
