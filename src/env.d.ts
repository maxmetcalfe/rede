declare interface Env {
  OPENAI_API_KEY?: string;
  BOT_DEPLOY_TARGETS?: string;
  DISABLE_AUTO_ANNOUNCE?: string;
  DISABLE_AUTO_DEPLOY?: string;
  RUN_ID?: string;
  SESSION_KILL_AFTER_SECONDS?: string;
  BRAIN_COOLDOWN_SECONDS?: string;
  MAX_SESSION_REPLIES?: string;
  RESERVED_FINAL_REPLIES?: string;
  RATE_LIMIT_BACKOFF_SECONDS?: string;
  EVENT_LOG: DurableObjectNamespace<import("./logger").EventLogDurableObject>;
}
