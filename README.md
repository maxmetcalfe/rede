# Durable Object Bots

This project extends the Cloudflare Durable Object starter so that every bot described in `bots.json` becomes a dedicated Durable Object instance with its own metadata and behavior.

## Project Structure

- `src/index.ts` – Worker entry point and the `BotDurableObject` class.
- `bots.json` – Source of truth for bot properties (`name`, `llmApiKey`, `prompt`, `createdAt`).
- `scripts/deploy-bots.mjs` – Helper that validates the bot list and runs `wrangler deploy` with the correct environment variables.

## Declaring Bots

Update `bots.json` with any bots you want to manage:

```json
[
  {
    "name": "test-bot",
    "llmApiKey": "replace-with-real-api-key",
    "prompt": "You are a friendly assistant that answers questions about this project.",
    "createdAt": "2024-01-01T00:00:00.000Z"
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
- `POST /bots/:name/deploy` – Persists the bot configuration into its Durable Object.
- `GET /bots/:name` – Returns the bot profile, automatically deploying it if necessary.

## Deploying Bots to Cloudflare

All deployments go through the helper script, which keeps `BOT_DEPLOY_TARGETS` in sync with the bots you want active.

### Deployment Quickstart

1. Run `npm install` (first time only).
2. Edit `bots.json` and customize the provided `test-bot` entry (replace the placeholder API key and prompt).
3. Deploy just that bot:
   ```bash
   npm run deploy:bots -- --bot test-bot
   ```
   The script validates that `test-bot` exists, then invokes `wrangler deploy --var BOT_DEPLOY_TARGETS=["test-bot"]` so only that bot is active.
4. Hit your Worker URL:
   ```bash
   curl https://<your-worker-subdomain>/bots/test-bot
   ```
   The response shows the stored metadata (with the API key hidden). Use `POST /bots/test-bot/deploy` later if you update `bots.json` and need to redeploy the Durable Object state.

### Deploy every bot in `bots.json`

```bash
npm run deploy:bots
```

### Deploy a single bot

Pass the bot name with `--bot`:

```bash
npm run deploy:bots -- --bot test-bot
```

The script validates that `test-bot` exists in `bots.json`, then runs `wrangler deploy --var BOT_DEPLOY_TARGETS=["test-bot"]`. Only bots included in that list will respond to API calls until you redeploy with a different selection.

### Deploy multiple specific bots

```bash
npm run deploy:bots -- --bot test-bot --bot support-bot
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
3. Each Durable Object stores `name`, `llmApiKey`, `prompt`, and `createdAt` so you can later wire them into your LLM execution pipeline.

