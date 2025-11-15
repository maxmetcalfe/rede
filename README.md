# Durable Object Bots

This project extends the Cloudflare Durable Object starter so that every bot described in `bots.json` becomes a dedicated Durable Object instance with its own metadata and behavior.

## Project Structure

- `src/index.ts` – Worker entry point and HTTP routing for bot management.
- `src/bot.ts` – Durable Object implementation plus registry helpers.
- `bots.json` – Source of truth for bot properties (`name`, `llmApiKey`, `prompt`, `createdAt`).
- `scripts/deploy-bots.mjs` – Helper that validates the bot list and runs `wrangler deploy` with the correct environment variables.

## Declaring Bots

Update `bots.json` with any bots you want to manage. The repository ships with three example bots (`A`, `B`, and `C`) to illustrate the format:

```json
[
  {
    "name": "A",
    "llmApiKey": "replace-with-real-api-key-a",
    "prompt": "You summarize repository changes in one sentence.",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  {
    "name": "B",
    "llmApiKey": "replace-with-real-api-key-b",
    "prompt": "You focus on deployment status and report blockers.",
    "createdAt": "2024-01-02T00:00:00.000Z"
  },
  {
    "name": "C",
    "llmApiKey": "replace-with-real-api-key-c",
    "prompt": "You give architecture-level advice for this project.",
    "createdAt": "2024-01-03T00:00:00.000Z"
  }
]
```

The `llmApiKey` field is stored in Durable Object state, so consider using Wrangler secrets or your own key-management workflow before pushing real keys.

## Local Development

```bash
npm install
npm run dev
```

Useful endpoints while running locally (`http://localhost:8787`):

- `GET /bots` – Lists all configured bots (LLM keys are hidden).
- `POST /bots/:name/deploy` – Persists the bot configuration into its Durable Object, shares the full bot roster (names + URLs), and seeds the bot's message history with its prompt on first deployment.
- `POST /bots/:name/message` – Sends a JSON `{ "to": "<recipient>", "content": "<text>" }` payload so one bot can message another.
- `GET /bots/:name` – Returns the bot profile, automatically deploying it if necessary.
- `GET /bots/:name/health` – Runs a Durable Object healthcheck that returns the number of `knownBots` plus the bot's message history.

### Bot metadata & message history

Every deployment call passes the list of all active bots and their canonical URLs (for example, `https://<worker>/bots/A`). Each Durable Object stores this peer list so bots know how to reach each other, and the healthcheck response surfaces the current `knownBots` count along with the latest message history.

On first deployment the Durable Object also seeds its message history with the prompt from `bots.json`, stored as a `{ timestamp, content, botId }` entry. Each time a bot is deployed it also announces its presence to every other bot by sending an `"I'm here"` message that shows up in the recipient's history—plus it logs the broadcast locally so you can see that it started talking. Future deployments preserve existing messages so each bot keeps its conversation log.

### Bot-to-bot messaging

Use `POST /bots/:name/message` to send a payload like:

```json
{
  "to": "B",
  "content": "Reminder: deploy is live."
}
```

The worker ensures both bots are deployed, then appends the message to the recipient's history. This API intentionally keeps the shape minimal so we can extend bot actions later.

### Durable Object local testing

Use Wrangler's local mode to spin up the Worker with real Durable Object RPC support and persisted state in `.wrangler/local-state`:

```bash
npm run deploy:local
```

This is helpful when you need to exercise Durable Object RPC calls (like `deploy`, `getProfile`, `healthcheck`, or any new methods) without deploying to Cloudflare.

## Deploying Bots to Cloudflare

All deployments go through the helper script, which keeps `BOT_DEPLOY_TARGETS` in sync with the bots you want active.

### Deployment Quickstart

1. Run `npm install` (first time only).
2. Edit `bots.json` and customize the provided sample entries (replace the placeholder API keys and prompts).
3. Deploy just that bot:
   ```bash
   npm run deploy:bots -- --bot A --url https://<your-worker-subdomain>
   ```
   The script validates that `A` exists, deploys the Worker with `BOT_DEPLOY_TARGETS=["A"]`, issues a `POST /bots/A/deploy` (which shares the full bot roster and URLs), and then polls `https://<your-worker-subdomain>/bots/A/health` until it receives HTTP 200 with the expected `knownBots` count.
4. Hit your Worker URL:
   ```bash
   curl https://<your-worker-subdomain>/bots/A
   ```
   The response shows the stored metadata (with the API key hidden). Use `POST /bots/A/deploy` later if you update `bots.json` and need to redeploy the Durable Object state.

### Deploy every bot in `bots.json`

```bash
npm run deploy:bots
```

### Deploy a single bot

Pass the bot name with `--bot`, and provide the Worker base URL (or set `BOT_HEALTHCHECK_URL`) so the script can run healthchecks:

```bash
BOT_HEALTHCHECK_URL=https://<your-worker-subdomain> npm run deploy:bots -- --bot B
```

Only bots included in the selection respond to API calls until you redeploy with a different list.

### Deploy multiple specific bots

```bash
npm run deploy:bots -- --bot A --bot B --url https://<your-worker-subdomain>
```

## Killing All Bots

When you need to delete every Durable Object (and the stored data) backing your bots, run:

```bash
npm run kill:bots
```

The command follows Cloudflare's recommended delete-migration flow:

- Removes the `BOTS` binding temporarily and deploys a config that applies a `deleted_classes` migration for `BotDurableObject`, which deletes every instance and its persisted data.
- Immediately appends a new `new_sqlite_classes` migration for `BotDurableObject`, redeploying the Worker with `BOT_DEPLOY_TARGETS=[]` so you start with a clean namespace.

Because this is destructive, make sure you've backed up any data you care about before running it. Afterward, redeploy whichever bots you want online again with `npm run deploy:bots`.

## After Deployment

1. Run `wrangler tail` (optional) to watch logs.
2. Use `curl` (or any HTTP client) against your Worker URL to hit the same `/bots` endpoints shown above.
3. Each Durable Object stores `name`, `llmApiKey`, `prompt`, `createdAt`, the latest `knownBots` list, and a message history (seeded with the prompt on first deploy) so you can later wire them into your LLM execution pipeline.
