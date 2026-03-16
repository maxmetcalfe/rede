# rede

`rede` is a Cloudflare Workers project for running a network of LLM-backed agents on top of Durable Objects.

Each bot in [`bots.json`](./bots.json) maps to one named Durable Object instance. Bots persist their own state, receive messages, call an LLM to decide what to say next, and can forward messages to other bots in the network.

The current implementation is best described as:

- One Durable Object class, many named instances.
- Message-driven agents with persistent per-bot state.
- LLM-generated replies with simple recipient routing.
- Structured coordination updates shared between bots.
- Short-lived conversation windows rather than open-ended autonomous execution.

It is not yet a general workflow engine, scheduler, or arbitrary graph runtime for long-running agent jobs.

## What Exists Today

At runtime, the worker:

- Loads bot definitions from `bots.json`.
- Auto-deploys active bots on first traffic.
- Stores each bot's prompt, peer list, message history, and conversation window in Durable Object storage.
- Stores a per-bot coordination ledger of claimed, requested, reported, and completed tasks.
- Lets bots exchange messages through worker endpoints.
- Runs an OpenAI-backed "brain" when a bot receives a message.
- Exposes lightweight observability via structured event logs and an HTML timeline.

Main files:

- [`src/index.ts`](./src/index.ts): Worker entrypoint, HTTP routes, deployment orchestration.
- [`src/bot.ts`](./src/bot.ts): Durable Object implementation, message handling, LLM calls, peer routing.
- [`src/logger.ts`](./src/logger.ts): In-memory event buffer and console logging.
- [`bots.json`](./bots.json): Bot definitions.
- [`scripts/deploy-bots.mjs`](./scripts/deploy-bots.mjs): Deploy selected bots and verify healthchecks.
- [`scripts/kill-bots.mjs`](./scripts/kill-bots.mjs): Delete and recreate the bot Durable Object namespace.

## Architecture

### 1. Bot definitions

Bots are declared statically in `bots.json`:

```json
[
  {
    "name": "A",
    "prompt": "Project: run a quick market scan using web.fetch...",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "speed": 2
  }
]
```

Supported fields:

- `name`: Durable Object instance name and bot identifier.
- `prompt`: The bot's role/instructions.
- `createdAt`: Optional seed timestamp.
- `speed`: Optional delay in seconds before the bot acts.
- `llmApiKey`: Optional per-bot OpenAI API key override.

### 2. Deployment model

All bots use the same Durable Object class: `BotDurableObject`.

For each active bot:

- The worker resolves a named stub with `env.BOTS.getByName(bot.name)`.
- `deploy()` persists the bot profile and peer list.
- The first deployment seeds message history with the bot's prompt.
- Deployments also announce presence to peers with an `"I'm here"` message.
- Presence announcements do not trigger LLM replies; they only update message history and peer awareness.

### 3. Message flow

Messages can enter the system through:

- `POST /bots/:name/message` from a client.
- Bot presence announcements during deployment.
- Follow-on messages emitted by another bot's LLM response.

When a bot receives a message, it:

- Appends the message to persistent history.
- Starts a conversation window if one is not already active.
- Waits for the configured `speed` delay.
- Builds a prompt from its instructions, recent conversation, known peers, and explicit self-context.
- Calls OpenAI through the Vercel AI SDK.
- Parses the reply as `{ "message": "...", "recipients": ["..."] }`.
- Stores its reply locally.
- Dispatches the reply to the selected peer bots.

Each bot also maintains a coordination ledger so it can keep track of who owns which task and what has already been reported or completed.

Each bot is told explicitly:

- Its own bot name.
- Its own public URL.
- Its creation time and configured delay.
- That it is a persistent agent backed by a Cloudflare Durable Object.
- The high-level architecture of the network it is participating in.
- The current coordination ledger for the run.

### Coordination protocol

Bots now coordinate with a small structured protocol carried alongside normal messages.

The reply schema supports:

```json
{
  "message": "short human-readable update",
  "recipients": ["B", "C"],
  "coordination": [
    {
      "type": "claim",
      "taskId": "a-test-endpoints",
      "owner": "A",
      "summary": "test the other worker endpoints"
    }
  ]
}
```

Supported `coordination.type` values:

- `claim`
- `request`
- `report`
- `complete`

If a sender does not use the structured format, the runtime also heuristically turns plain-text commitments such as `I'm going to test your other endpoints` or `I'll search the web for durable object docs` into task claims.

### 4. Tool use

Bots can call one built-in tool:

- `web_fetch({ url })`

This tool:

- Allows only `http` and `https`.
- Blocks localhost and private/local network targets.
- Fetches only text-like content.
- Truncates large responses before returning them to the model.

### 5. Conversation lifetime

Bots do not run forever.

Each bot session now runs until an explicit kill time is reached. By default, a session lasts 120 seconds from the first non-presence work item in that session. During that window, bots keep coordinating with each other. Once the kill time is reached, the session stops; a later non-presence message starts a fresh session with a new kill time.

## Current Constraints

These are worth stating explicitly before open-sourcing:

- The system uses one Durable Object class with many instances, not multiple worker types or a dynamic execution graph.
- Peer-to-peer messaging is routed back through the worker's HTTP API, not purely through direct Durable Object RPC.
- There is no durable queue, scheduler, planner, retry policy, or job orchestration layer.
- Event logs are kept in-memory in the worker process and are intended for development/inspection, not durable production observability.
- The bot model is currently `gpt-4.1`.
- The project assumes an OpenAI-compatible API key via `OPENAI_API_KEY`, unless a bot supplies its own `llmApiKey`.

## Getting Started

### Prerequisites

- Node.js 18+.
- An OpenAI API key.
- Cloudflare account and Wrangler for deployment.

### Install

```bash
npm install
```

### Local development

Set your API key in `.dev.vars`:

```bash
OPENAI_API_KEY=your_key_here
```

Then run:

```bash
npm run dev
```

The default local worker URL is:

```text
http://localhost:8787
```

If you need Durable Object local persistence with Wrangler's local state directory:

```bash
npm run deploy:local
```

## HTTP API

### `GET /bots`

Lists active bot definitions with API keys redacted.

### `POST /bots/:name/deploy`

Deploys or refreshes one bot's stored state.

Effects:

- Persists bot metadata.
- Stores the current peer roster.
- Seeds initial history if needed.
- Announces presence to peer bots.

### `GET /bots/:name`

Returns one bot profile. If the bot has not been deployed yet, the worker deploys it on demand.

### `GET /bots/:name/health`

Runs a healthcheck against the bot Durable Object and returns:

- status
- known bot count
- message history

### `POST /bots/:name/message`

Sends a message from one bot to another:

```json
{
  "to": "B",
  "content": "Start with the pricing pages."
}
```

The sender bot is the `:name` path segment.

### `POST /bots/:name/reset`

Clears one bot's Durable Object state.

### `POST /bots/reset`

Clears all active bot Durable Object state and resets the in-memory event log.

### `GET /bots/events`

Returns the recent event stream as NDJSON.

### `GET /bots/events/timeline`

Returns a simple HTML timeline view of recent events.

### `POST /bots/events/reset`

Clears the in-memory event log buffer.

## Deployment

The recommended deployment path uses the helper script:

```bash
npm run deploy:bots -- --url https://<your-worker-subdomain>
```

To deploy a subset:

```bash
npm run deploy:bots -- --bot A --bot B --url https://<your-worker-subdomain>
```

What the script does:

- Validates requested bot names.
- Deploys the worker with `BOT_DEPLOY_TARGETS` set to the selected bot list.
- Calls each bot's `/deploy` endpoint.
- Polls `/health` until each selected bot responds.

Environment variables used during deployment/runtime:

- `OPENAI_API_KEY`: Shared LLM key.
- `BOT_DEPLOY_TARGETS`: JSON array of active bot names.
- `BOT_HEALTHCHECK_URL`: Base URL used by scripts if `--url` is omitted.
- `DISABLE_AUTO_DEPLOY`: Set to `true` to stop first-request auto deployment.
- `DISABLE_AUTO_ANNOUNCE`: Set to `true` to suppress `"I'm here"` fanout during deploys.
- `SESSION_KILL_AFTER_SECONDS`: Absolute session duration for coordinated work. Defaults to `120`.
- `RUN_ID`: Optional label used by archive tooling and event snapshots.

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

Artifacts are written under [`runs/`](./runs).

## Resetting Durable Objects

To delete all bot Durable Objects and recreate a fresh namespace:

```bash
npm run kill:bots
```

This is destructive. Existing bot state and history will be removed.

For local test runs, a lighter-weight reset is usually enough:

```bash
curl -X POST http://127.0.0.1:8787/bots/reset
curl -X POST http://127.0.0.1:8787/bots/events/reset
```

## Open Source Notes

Before publishing, you may want to review:

- `package.json` is currently marked `"private": true`.
- Example prompts in `bots.json` are task-specific; replace them if you want a more neutral public default.
- Generated artifacts under `runs/` may not belong in a public repository unless you want them as examples.
- You should avoid committing real API keys, deployment URLs, or production run data.

## Roadmap Gaps

If the long-term goal is "an arbitrary number of durable worker agents executing as a network," the next missing pieces are likely:

- A first-class task or workflow abstraction instead of raw message passing.
- Durable queues and retries.
- Better routing and coordination primitives than prompt-only recipient selection.
- Direct Durable Object RPC for inter-agent messaging.
- Durable observability and run state beyond the in-memory event buffer.
- Longer-lived execution semantics than the current 20-second conversation window.
