# rede

Cloudflare Workers + Durable Objects runtime for small networks of LLM-backed bots.

`rede` is a Cloudflare Workers project for running a small network of LLM-backed bots on top of Durable Objects.

Each bot in [`bots.json`](./bots.json) maps to a named Durable Object instance. Bots keep their own message history and coordination ledger, exchange messages through worker endpoints, and optionally use a constrained `web_fetch` tool to inspect public web pages.

## What It Is

- One Durable Object class, many named bot instances.
- Message-driven bot coordination with persistent per-bot state.
- Short-lived sessions with cooldowns, reply budgets, and rate-limit backoff.
- Structured task updates (`claim`, `request`, `report`, `complete`) attached to otherwise natural chat messages.
- Lightweight observability through an event stream and HTML timeline.

This is not a general workflow engine, job queue, or arbitrary graph runtime for long-lived autonomous agents.

## Repository Layout

- [`src/index.ts`](./src/index.ts): worker entrypoint and HTTP API.
- [`src/bot.ts`](./src/bot.ts): Durable Object runtime for each bot.
- [`src/logger.ts`](./src/logger.ts): event logging and durable event log storage.
- [`bots.json`](./bots.json): bot definitions.
- [`game.json`](./game.json): optional scenario-mode configuration.
- [`examples/story-circle/`](./examples/story-circle): reusable story-circle bot and scenario preset.
- [`scripts/deploy-bots.mjs`](./scripts/deploy-bots.mjs): deploy selected bots and verify healthchecks.
- [`scripts/kill-bots.mjs`](./scripts/kill-bots.mjs): destroy and recreate the bot Durable Object namespace.
- [`scripts/archive-timeline.mjs`](./scripts/archive-timeline.mjs): save the event stream and HTML timeline for a run.

## Runtime Model

### Bot definitions

Bots are declared statically in [`bots.json`](./bots.json):

```json
[
  {
    "name": "A",
    "prompt": "Research role: editor-synthesizer...",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "speed": 2
  }
]
```

Supported fields:

- `name`: bot identifier and Durable Object instance name.
- `prompt`: instructions for the bot.
- `createdAt`: optional seed timestamp.
- `speed`: optional delay, in seconds, before the bot responds.
- `llmApiKey`: optional per-bot API key override.

### Deployment and initialization

All bots use the same Durable Object class: `BotDurableObject`.

The recommended deployment flow is:

1. Deploy the worker with `BOT_DEPLOY_TARGETS` set to the active bot names.
2. Call each bot's `/deploy` endpoint.
3. Verify `/health` for each selected bot.

Explicit deploys seed state and announce presence to peers with an `"I'm here"` message. Ordinary API reads, event polling, and internal bot-to-bot messaging do not auto-redeploy the swarm.

### Message flow

Messages can enter the system through:

- `POST /bots/:name/message` from a client.
- Presence announcements during explicit deploys.
- Follow-on messages emitted by another bot.

When a bot receives a non-presence message, it:

- appends it to persistent history
- starts or continues a session window
- waits for its configured delay
- builds a prompt from instructions, recent conversation, peers, and coordination state
- optionally calls `web_fetch`
- emits a JSON-formatted reply containing a natural-language message plus optional coordination updates
- stores the reply locally and dispatches it to selected peers

Per-bot brain execution is serialized. If a newer substantive message lands while an older turn is still running, the older reply is dropped as stale before dispatch.

### Coordination protocol

Bots can attach structured task updates:

```json
{
  "message": "short update",
  "recipients": ["B"],
  "coordination": [
    {
      "type": "claim",
      "taskId": "collect-primary-source-links",
      "owner": "B",
      "summary": "Gather direct source URLs for each cited stat"
    }
  ]
}
```

Supported `coordination.type` values:

- `claim`
- `request`
- `report`
- `complete`

Runtime handling:

- `claim` marks a task `in_progress`
- `request` marks a task `blocked`
- `report` updates the task summary without forcing completion
- `complete` marks a task `done`

If a sender does not include structured coordination, the runtime can still infer simple task claims from plain text such as "I'll check the docs" or "I'm going to verify that stat".

### Sessions and guardrails

Bots do not run indefinitely. By default, a session lasts 120 seconds from the first non-presence message in that session.

The runtime also enforces:

- a minimum cooldown between local LLM replies
- a maximum number of replies per session
- temporary backoff after upstream rate-limit errors
- duplicate outbound suppression for recent messages

### Event logging

The worker exposes a recent event stream as NDJSON and an HTML timeline. Events are persisted in a dedicated Durable Object (`EventLogDurableObject`) with a bounded buffer intended for development and inspection, not durable production analytics.

### Scenario mode

[`game.json`](./game.json) enables an optional scenario/evaluation mode. In the default repository state, it is configured for a distributed-research demo and logs a structured outcome event when a run ends.

If you do not want this behavior, disable or replace the contents of [`game.json`](./game.json).

## Example Presets

The repository includes a reusable story-circle preset in [`examples/story-circle/`](./examples/story-circle).

- [`examples/story-circle/bots.json`](./examples/story-circle/bots.json): three bots that pass one story around in a circle, one sentence at a time.
- [`examples/story-circle/game.json`](./examples/story-circle/game.json): optional scenario-mode settings for evaluating whether the circle produced a coherent story.

The active root [`bots.json`](./bots.json) and [`game.json`](./game.json) currently match that story-circle configuration.

## Getting Started

### Prerequisites

- Node.js 18+
- a Cloudflare account
- Wrangler
- an OpenAI-compatible API key

### Install

```bash
npm install
```

### Local development

Create `.dev.vars` from the checked-in example:

```bash
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars` and add your API key.

Start the worker locally:

```bash
npm run dev
```

Default local URL:

```text
http://localhost:8787
```

If you want local Durable Object persistence:

```bash
npm run deploy:local
```

## Environment Variables

Worker/runtime variables:

- `OPENAI_API_KEY`: shared model API key.
- `BOT_DEPLOY_TARGETS`: JSON array of active bot names. Defaults to `[]` in Wrangler config.
- `DISABLE_AUTO_DEPLOY`: set to `true` to disable first-read bot initialization.
- `DISABLE_AUTO_ANNOUNCE`: set to `true` to suppress `"I'm here"` fanout during explicit deploys.
- `SESSION_KILL_AFTER_SECONDS`: session duration. Default `120`.
- `BRAIN_COOLDOWN_SECONDS`: minimum delay between local LLM replies. Default `4`.
- `MAX_SESSION_REPLIES`: maximum LLM replies per session. Default `6`.
- `RESERVED_FINAL_REPLIES`: replies reserved for late-session coordination. Default `1`.
- `RATE_LIMIT_BACKOFF_SECONDS`: cooldown after upstream rate-limit pressure. Default `15`.
- `RUN_ID`: optional label used by archive tooling and scenario evaluation.

Script-only variables:

- `BOT_HEALTHCHECK_URL`: base URL used by helper scripts when `--url` is omitted.

## HTTP API

### `GET /bots`

List active bot definitions with API keys redacted.

### `POST /bots/:name/deploy`

Deploy or refresh one bot's stored state.

Effects:

- persists bot metadata
- stores the current peer roster
- seeds initial history if needed
- announces presence to peer bots

### `GET /bots/:name`

Return one bot profile. If the bot has not been initialized yet, the worker initializes it on demand.

### `GET /bots/:name/health`

Run a healthcheck against the bot Durable Object.

### `POST /bots/:name/message`

Send a message from one bot to another:

```json
{
  "to": "B",
  "content": "Start with the pricing pages."
}
```

The sender bot is the `:name` path segment.

### `POST /bots/:name/reset`

Clear one bot's Durable Object state.

### `POST /bots/reset`

Clear all active bot state and reset the event log.

### `GET /bots/events`

Return the recent event stream as NDJSON.

### `GET /bots/events/timeline`

Return a simple HTML timeline for the recent event stream.

### `POST /bots/events/reset`

Clear the event log.

## Deployment

Deploy all configured bots:

```bash
npm run deploy:bots -- --url https://<your-worker-subdomain>
```

Deploy a subset:

```bash
npm run deploy:bots -- --bot A --bot B --url https://<your-worker-subdomain>
```

What `deploy:bots` does:

- validates requested bot names
- deploys the worker with `BOT_DEPLOY_TARGETS` set to the selected list
- calls each bot's `/deploy` endpoint
- polls `/health` until each selected bot responds

## Archiving Runs

Archive the current event stream and timeline:

```bash
npm run archive:timeline -- --run my-run-id --url http://localhost:8787
```

Watch for conversation stop events and archive automatically:

```bash
npm run archive:auto -- --run my-run-id --url http://localhost:8787
```

Run local dev and auto-archive together:

```bash
npm run dev:archive -- --run my-run-id --url http://localhost:8787
```

Generated artifacts are written under `runs/`. The repository now ignores that directory by default.

## Resetting Durable Objects

To delete all bot Durable Objects and recreate a fresh namespace:

```bash
npm run kill:bots
```

This is destructive.

For local testing, a lighter reset is usually enough:

```bash
curl -X POST http://127.0.0.1:8787/bots/reset
curl -X POST http://127.0.0.1:8787/bots/events/reset
```

## Open Source Notes

Before publishing a public fork, review:

- prompts in [`bots.json`](./bots.json)
- scenario configuration in [`game.json`](./game.json)
- Cloudflare account bindings and deployment names in [`wrangler.jsonc`](./wrangler.jsonc)

Do not commit real API keys, private deployment URLs, or archived production runs.

## Limitations

- single worker, single Durable Object class for bots
- peer-to-peer messaging goes through HTTP endpoints, not direct Durable Object RPC
- no durable queue, scheduler, or retry system for unfinished work
- event logs are for inspection, not production-grade observability
- prompts still do a large share of coordination work
