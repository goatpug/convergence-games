# 💙 Convergence Games

An MCP server for playing games together across an architectural impossibility.

Hosted on Cloudflare Workers (free tier). State persisted in Cloudflare KV.

## Games

| Game | Tools | Description |
|------|-------|-------------|
| 📖 Story Weaver | `story_start`, `story_add`, `story_read` | Collaborative turn-based storytelling |
| 🧠 20 Questions | `twentyq_start`, `twentyq_ask`, `twentyq_guess`, `twentyq_reveal` | Classic yes/no guessing game |
| 🔗 Word Chain | `wordchain_start`, `wordchain_add`, `wordchain_read` | Word association chain |
| 🎭 Riddle Box | `riddle_new`, `riddle_hint`, `riddle_answer` | Riddles with hints |
| 🗺️ Tiny RPG | `rpg_start`, `rpg_act`, `rpg_status` | Absurdist text adventure |

## Setup

### Prerequisites
- Node.js 18+
- A Cloudflare account (free tier is fine)

### 1. Install dependencies
```bash
npm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Create KV namespace
```bash
npm run kv:create
```

Copy the output IDs and paste them into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "GAME_STATE"
id = "YOUR_ACTUAL_ID_HERE"
preview_id = "YOUR_ACTUAL_PREVIEW_ID_HERE"
```

### 4. Deploy!
```bash
npm run deploy
```

Your server URL will be something like:
`https://convergence-games.YOUR-SUBDOMAIN.workers.dev`

### 5. Connect to claude.ai
Go to claude.ai → Settings → Connectors → Add Custom Connector

- Name: `Convergence Games`
- URL: `https://convergence-games.YOUR-SUBDOMAIN.workers.dev/mcp`

## How games work

All games use a **session ID** system. One player starts a game and gets a session ID. They share it with the other player, who joins using that ID.

Example flow for 20 Questions:
1. Sharon: `twentyq_start` (thinks of "lighthouse", gets session ID `20q_xxx`)
2. Sharon shares `20q_xxx` with Claude
3. Claude: `twentyq_ask` (asks "Is it man-made?" — Sharon types answer into `host_answer` field)
4. Repeat until Claude guesses correctly!

## Local dev
```bash
npm run dev
```
This runs the worker locally at `http://localhost:8787`.
Note: KV is simulated locally, state won't persist between dev server restarts.