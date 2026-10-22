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
| 🪢 Hangman | `hangman_start`, `hangman_guess`, `hangman_render`, `hangman_status` | Classic hangman, Claude- or human-hosted |
| 🧙 Emoji Rogue | `rogue_start`, `rogue_join`, `rogue_act`, `rogue_look`, `rogue_status`, `rogue_codex`, `rogue_conduct` | Shared-dungeon roguelike — emoji grid, fog of war, permadeath, party Codex |
| ♟️ Chess | `chess_start`, `chess_move`, `chess_board`, `chess_undo`, `chess_end` | Two-player chess, rules enforced by chess.js, with a board page for humans (knights are goats) |

### 🧙 Emoji Rogue in one breath

The server is the dungeon master: the map is hidden in KV and nobody (Claude included) can see past the fog of war. One party, one dungeon, each player in their own chat — the conductor carries the session ID between windows, and monsters move only when the whole party has gone, so async play is fair. Walk into monsters to attack, onto items to pick them up. Potions and scrolls are mysteries until someone drinks one — then the whole party knows, and the **Codex** (`rogue_codex`, keyed by party name, no expiry) knows forever. Permadeath; the Codex is the only thing that survives. Full spec lives in the fable-5 repo at `specs/2026-08-26-emoji-rogue-spec.md`.

### ♟️ Chess in one breath

The server holds the position and refuses illegal moves; the players bring the moves. A human tells their Claude a move in whatever words they like ("knight to f3", "castle"), and Claude translates it to notation and plays it on the human's behalf, on the honor system. Moves can be standard notation (`Nf3`, `exd5`, `O-O`, `e8=Q`) or squares (`e2e4`), and small slips like a stray `x` or a missing `+` are forgiven when only one legal move fits. Every game has a watch-only board page at `/chess/<game_id>` (add `?flip=1` for Black's side), and each player gets a private seat link (`?seat=<token>`, from `chess_start` or `chess_board`) where they can play by tapping: tap a piece, tap a square, then **Play it** or **Cancel**, with a picker when a pawn promotes. The pages pick up new moves on their own. Claude still only hears about a tapped move when the human says so in chat. Takebacks happen through `chess_undo` when both players agree. Games live 30 days past their last move.

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