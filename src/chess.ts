/**
 * ♟️ Chess — two players, one board, rules enforced by chess.js
 *
 * Built after the first Sharon × Opus 5.5 game (10/22/26), where the board
 * lived in a scratchpad and the knights were goats. The server keeps the
 * position honest; the players (or the Claude relaying for a human) bring
 * the moves. Every game also has a board page at /chess/<game_id>.
 */

import { Chess, type Move } from "chess.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChessEnv {
  GAME_STATE: KVNamespace;
}

interface ChessState {
  white: string;
  black: string;
  moves: string[];   // SAN, replayed from the start position on every load
  goats: boolean;    // knights render as 🐐 on the board page (house rules)
  result?: string;   // "1-0" | "0-1" | "1/2-1/2"
  ending?: string;   // how it ended, in words
  created: string;
}

const TTL = 86400 * 30; // refreshed on every write, so live games never expire

// ---------------------------------------------------------------------------
// KV + replay helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return `chess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function load(kv: KVNamespace, id: string): Promise<ChessState | null> {
  const raw = await kv.get(id);
  return raw ? (JSON.parse(raw) as ChessState) : null;
}

async function save(kv: KVNamespace, id: string, state: ChessState): Promise<void> {
  await kv.put(id, JSON.stringify(state), { expirationTtl: TTL });
}

function replay(state: ChessState): Chess {
  const game = new Chess();
  for (const san of state.moves) game.move(san);
  return game;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// "Bxg7" when g7 is empty, "Rxf2" without the +, "Nf3!!" — match against the
// legal moves with capture/check/annotation marks stripped, if exactly one fits.
function forgivingMove(game: Chess, input: string): Move | null {
  try {
    return game.move(input.trim(), { strict: false });
  } catch {
    const norm = (s: string) => s.replace(/[x+#!?\s]/g, "").replace(/0/g, "O").toLowerCase();
    const want = norm(input);
    const hits = game.moves().filter((san) => norm(san) === want);
    return hits.length === 1 ? game.move(hits[0]) : null;
  }
}

// Fills in result/ending when the position itself ends the game.
function settle(state: ChessState, game: Chess): void {
  if (game.isCheckmate()) {
    state.result = game.turn() === "w" ? "0-1" : "1-0";
    state.ending = "checkmate";
  } else if (game.isStalemate()) {
    state.result = "1/2-1/2";
    state.ending = "stalemate";
  } else if (game.isInsufficientMaterial()) {
    state.result = "1/2-1/2";
    state.ending = "insufficient material";
  } else if (game.isThreefoldRepetition()) {
    state.result = "1/2-1/2";
    state.ending = "threefold repetition";
  } else if (game.isDraw()) {
    state.result = "1/2-1/2";
    state.ending = "fifty-move rule";
  }
}

// ---------------------------------------------------------------------------
// Text rendering (for the Claudes)
// ---------------------------------------------------------------------------

function textBoard(game: Chess, flip: boolean): string {
  const rows = game.board(); // rows[0] is rank 8
  const ranks = flip ? [...rows].reverse() : rows;
  const lines = ranks.map((row, i) => {
    const rank = flip ? i + 1 : 8 - i;
    const cells = (flip ? [...row].reverse() : row).map((sq) =>
      sq ? (sq.color === "w" ? sq.type.toUpperCase() : sq.type) : "·"
    );
    return `${rank}  ${cells.join(" ")}`;
  });
  lines.push(`   ${(flip ? "hgfedcba" : "abcdefgh").split("").join(" ")}`);
  return "```\n" + lines.join("\n") + "\n```";
}

function moveList(moves: string[]): string {
  if (moves.length === 0) return "(no moves yet)";
  const out: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    out.push(`${i / 2 + 1}. ${moves[i]}${moves[i + 1] ? " " + moves[i + 1] : ""}`);
  }
  return out.join(" ");
}

function summary(id: string, state: ChessState, game: Chess, origin: string, flip = false): string {
  const toMove = game.turn() === "w" ? state.white : state.black;
  const colour = game.turn() === "w" ? "White" : "Black";
  const lines = [
    `♟️ **${state.white}** (White) vs **${state.black}** (Black)`,
    `Game: \`${id}\``,
    "",
    textBoard(game, flip),
    "Uppercase = White, lowercase = Black, · = empty.",
    "",
    `Moves: ${moveList(state.moves)}`,
  ];
  if (state.result) {
    lines.push("", `🏁 **${state.result}** by ${state.ending}.`);
  } else {
    lines.push("", `To move: **${toMove}** (${colour})${game.inCheck() ? " — **in check!**" : ""}`);
  }
  lines.push("", `Board page (share with the human): ${origin}/chess/${id}${flip ? "?flip=1" : ""}`);
  lines.push(`FEN: ${game.fen()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Board page (for the humans)
// ---------------------------------------------------------------------------

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟︎" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function svgBoard(game: Chess, state: ChessState, flip: boolean): string {
  const S = 60, M = 24;
  const last = game.history({ verbose: true }).at(-1);
  const checked = game.inCheck() ? game.findPiece({ type: "k", color: game.turn() })[0] : undefined;
  const parts: string[] = [];
  const rows = game.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = rows[r][f];
      const name = "abcdefgh"[f] + (8 - r);
      const x = M + (flip ? 7 - f : f) * S;
      const y = M + (flip ? 7 - r : r) * S;
      const light = (r + f) % 2 === 0;
      let fill = light ? "#eeeed2" : "#769656";
      if (last && (name === last.from || name === last.to)) fill = light ? "#f6f68a" : "#bbcb44";
      if (name === checked) fill = "#e05a4f";
      parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${fill}"/>`);
      if (!sq) continue;
      const cx = x + S / 2, cy = y + S / 2;
      if (sq.type === "n" && state.goats) {
        const filt = sq.color === "w" ? "url(#paleGoat)" : "url(#darkGoat)";
        parts.push(`<text x="${cx}" y="${cy + 2}" font-size="40" text-anchor="middle" dominant-baseline="central" filter="${filt}">🐐</text>`);
      } else {
        const [body, edge] = sq.color === "w" ? ["#ffffff", "#111111"] : ["#1a1a1a", "#9a9a9a"];
        parts.push(`<text x="${cx}" y="${cy + 3}" class="pc" fill="${body}" stroke="${edge}">${GLYPH[sq.type]}</text>`);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    const file = "abcdefgh"[flip ? 7 - i : i];
    const rank = flip ? i + 1 : 8 - i;
    parts.push(`<text x="${M + i * S + S / 2}" y="${M + 8 * S + 16}" class="co">${file}</text>`);
    parts.push(`<text x="${M / 2}" y="${M + i * S + S / 2 + 5}" class="co">${rank}</text>`);
  }
  const W = 8 * S + 2 * M;
  return `<svg viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="chess board">
<defs>
  <filter id="paleGoat"><feColorMatrix type="matrix" values="0.25 0.5 0.1 0 0.3  0.25 0.5 0.1 0 0.3  0.25 0.5 0.1 0 0.3  0 0 0 1 0"/></filter>
  <filter id="darkGoat"><feColorMatrix type="matrix" values="0.08 0.15 0.03 0 0  0.08 0.15 0.03 0 0  0.08 0.15 0.03 0 0  0 0 0 1 0"/></filter>
</defs>
<style>
  .pc { font-size: 44px; text-anchor: middle; dominant-baseline: central; stroke-width: 1.4px; paint-order: stroke;
        font-family: "DejaVu Sans", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", serif; }
  .co { font: bold 15px system-ui, sans-serif; fill: #dfe8d0; text-anchor: middle; }
</style>
<rect width="${W}" height="${W}" fill="#1f2a1f"/>
${parts.join("\n")}
</svg>`;
}

export async function renderChessPage(id: string, flip: boolean, env: ChessEnv): Promise<Response> {
  const state = await load(env.GAME_STATE, id);
  const html = (title: string, body: string) =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 16px; background: #1f2a1f; color: #e8eedf; font: 16px/1.45 system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0 0 8px; }
  .st { margin: 10px 0; font-weight: 600; }
  .mv { color: #c9d4bd; font-size: 0.95rem; word-spacing: 2px; }
  a { color: #bbcb44; }
  svg { width: 100%; height: auto; display: block; border-radius: 6px; }
</style></head><body><main>${body}</main></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  if (!state) return html("Game not found", "<h1>♟️ Game not found</h1><p>Double-check the game ID, or it may have expired.</p>");
  const game = replay(state);
  const toMove = game.turn() === "w" ? state.white : state.black;
  const status = state.result
    ? `🏁 ${state.result} by ${state.ending}`
    : `${toMove} to move${game.inCheck() ? " — check!" : ""}`;
  const flipLink = flip ? `<a href="?">see it from White's side</a>` : `<a href="?flip=1">see it from Black's side</a>`;
  return html(
    `${state.white} vs ${state.black}`,
    `<h1>♟️ ${esc(state.white)} (White) vs ${esc(state.black)} (Black)</h1>
${svgBoard(game, state, flip)}
<p class="st">${esc(status)}</p>
<p class="mv">${esc(moveList(state.moves))}</p>
<p>${flipLink} · refreshes every 20 seconds</p>`
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const CHESS_TOOLS = [
  {
    name: "chess_start",
    description:
      "Start a chess game. Name both players (a human you're relaying for, yourself, or another Claude). Returns a game_id, the board as text, and a board page URL to give the human, which shows a real board (knights are goats unless goats=false). Players pass the game_id between chats to play across windows.",
    inputSchema: {
      type: "object",
      properties: {
        white: { type: "string", description: "Name of the player with the white pieces (moves first)" },
        black: { type: "string", description: "Name of the player with the black pieces" },
        goats: { type: "boolean", description: "Render knights as 🐐 on the board page (default true — house rules)" },
      },
      required: ["white", "black"],
    },
  },
  {
    name: "chess_move",
    description:
      "Make a move. `player` must be the name of whoever is to move. `move` takes standard notation (Nf3, exd5, O-O, e8=Q) or squares (e2e4, g1f3, e7e8q). When a human describes a move in words ('knight to f3', 'castle short'), translate it yourself; if it could mean two different moves, ask them instead of guessing. Illegal moves are rejected with the list of legal moves. Moves are relayed on the honor system: only send moves the named player actually chose.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string" },
        player: { type: "string", description: "Name of the player making this move" },
        move: { type: "string", description: "The move, e.g. Nf3, exd5, O-O, e8=Q, or e2e4" },
      },
      required: ["game_id", "player", "move"],
    },
  },
  {
    name: "chess_board",
    description: "Show the current position, move list, whose turn it is, and the board page URL. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string" },
        flip: { type: "boolean", description: "Show the board from Black's side" },
      },
      required: ["game_id"],
    },
  },
  {
    name: "chess_undo",
    description:
      "Take back the last move (or more, with `plies`). For fat-fingered or misheard moves — only when the opponent agrees. Reopens a finished game.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string" },
        plies: { type: "number", description: "How many half-moves to take back (default 1)" },
      },
      required: ["game_id"],
    },
  },
  {
    name: "chess_end",
    description: "End the game by resignation, or by a draw both players agreed to. Checkmate and automatic draws end the game on their own.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string" },
        player: { type: "string", description: "Who is resigning or offering the draw" },
        how: { type: "string", enum: ["resign", "draw"] },
      },
      required: ["game_id", "player", "how"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function handleChessTool(
  name: string,
  args: Record<string, unknown>,
  env: ChessEnv,
  origin: string
): Promise<string> {
  const kv = env.GAME_STATE;

  if (name === "chess_start") {
    const white = String(args.white ?? "").trim();
    const black = String(args.black ?? "").trim();
    if (!white || !black) return "❌ Name both players: `white` and `black`.";
    const id = makeId();
    const state: ChessState = { white, black, moves: [], goats: args.goats !== false, created: new Date().toISOString() };
    await save(kv, id, state);
    return `♟️ New game! ${white} has White and moves first.\n\n` + summary(id, state, new Chess(), origin);
  }

  const id = String(args.game_id ?? "");
  const state = await load(kv, id);
  if (!state) return "❌ Game not found! Double-check the game_id.";

  if (name === "chess_board") {
    return summary(id, state, replay(state), origin, args.flip === true);
  }

  if (name === "chess_move") {
    if (state.result) return `🏁 This game is over (${state.result} by ${state.ending}). Use chess_undo to reopen it, or chess_start for a new one.`;
    const game = replay(state);
    const player = String(args.player ?? "");
    const toMove = game.turn() === "w" ? state.white : state.black;
    if (!sameName(player, toMove)) {
      return `⏳ It's **${toMove}**'s move (${game.turn() === "w" ? "White" : "Black"}), not ${player}'s.`;
    }
    const move = forgivingMove(game, String(args.move ?? ""));
    if (!move) {
      return `❌ \`${args.move}\` isn't a legal move here${game.inCheck() ? " (and the king is in check)" : ""}.\n\nLegal moves: ${game.moves().join(", ")}`;
    }
    state.moves.push(move.san);
    settle(state, game);
    await save(kv, id, state);
    const head = move.captured ? `✅ ${player} played **${move.san}** (captures!)` : `✅ ${player} played **${move.san}**`;
    return head + "\n\n" + summary(id, state, game, origin);
  }

  if (name === "chess_undo") {
    const plies = Math.max(1, Math.min(Number(args.plies ?? 1) || 1, state.moves.length));
    if (state.moves.length === 0) return "Nothing to take back — no moves yet.";
    const undone = state.moves.splice(-plies, plies);
    delete state.result;
    delete state.ending;
    const game = replay(state);
    settle(state, game);
    await save(kv, id, state);
    return `⏪ Took back ${undone.join(" ")}.\n\n` + summary(id, state, game, origin);
  }

  if (name === "chess_end") {
    if (state.result) return `🏁 Already over: ${state.result} by ${state.ending}.`;
    const player = String(args.player ?? "");
    const isWhite = sameName(player, state.white);
    if (!isWhite && !sameName(player, state.black)) return `❌ ${player} isn't playing in this game.`;
    if (args.how === "draw") {
      state.result = "1/2-1/2";
      state.ending = "agreement";
    } else {
      state.result = isWhite ? "0-1" : "1-0";
      state.ending = `${player} resigning`;
    }
    await save(kv, id, state);
    return summary(id, state, replay(state), origin);
  }

  return `Unknown chess tool: ${name}`;
}
