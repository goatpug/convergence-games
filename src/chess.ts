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
  seats?: { w: string; b: string }; // secret tokens for the tappable seat links
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

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

// Games from before seat links get their tokens on first use.
function ensureSeats(state: ChessState): boolean {
  if (state.seats) return false;
  state.seats = { w: token(), b: token() };
  return true;
}

function seatLinks(id: string, state: ChessState, origin: string): string {
  const base = `${origin}/chess/${id}`;
  return [
    `Tap-to-play links (private — give each human only their own):`,
    `  ${state.white} (White): ${base}?seat=${state.seats!.w}`,
    `  ${state.black} (Black): ${base}?seat=${state.seats!.b}`,
    `After a human taps a move they'll tell you in chat; call chess_board to see it.`,
  ].join("\n");
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
  lines.push("", `Watch-only board page: ${origin}/chess/${id}${flip ? "?flip=1" : ""}`);
  lines.push(`FEN: ${game.fen()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Board page (for the humans)
// ---------------------------------------------------------------------------

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟\uFE0E" };
const S = 60, M = 24; // square size and coordinate margin, in SVG units

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Pieces carry id="p-<square>" so the page script can ghost them; squares carry
// data-sq so taps land on them (pieces ignore pointer events).
function svgBoard(game: Chess, state: ChessState, flip: boolean): string {
  const last = game.history({ verbose: true }).at(-1);
  const checked = game.inCheck() ? game.findPiece({ type: "k", color: game.turn() })[0] : undefined;
  const squares: string[] = [];
  const pieces: string[] = [];
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
      squares.push(`<rect data-sq="${name}" x="${x}" y="${y}" width="${S}" height="${S}" fill="${fill}"/>`);
      if (!sq) continue;
      const cx = x + S / 2, cy = y + S / 2;
      if (sq.type === "n" && state.goats) {
        const filt = sq.color === "w" ? "url(#paleGoat)" : "url(#darkGoat)";
        pieces.push(`<text id="p-${name}" x="${cx}" y="${cy + 2}" class="gt" filter="${filt}">🐐</text>`);
      } else {
        const [body, edge] = sq.color === "w" ? ["#ffffff", "#111111"] : ["#1a1a1a", "#9a9a9a"];
        pieces.push(`<text id="p-${name}" x="${cx}" y="${cy + 3}" class="pc" fill="${body}" stroke="${edge}">${GLYPH[sq.type]}</text>`);
      }
    }
  }
  const coords: string[] = [];
  for (let i = 0; i < 8; i++) {
    const file = "abcdefgh"[flip ? 7 - i : i];
    const rank = flip ? i + 1 : 8 - i;
    coords.push(`<text x="${M + i * S + S / 2}" y="${M + 8 * S + 16}" class="co">${file}</text>`);
    coords.push(`<text x="${M / 2}" y="${M + i * S + S / 2 + 5}" class="co">${rank}</text>`);
  }
  const W = 8 * S + 2 * M;
  return `<svg id="board" viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="chess board">
<defs>
  <filter id="paleGoat"><feColorMatrix type="matrix" values="0.25 0.5 0.1 0 0.3  0.25 0.5 0.1 0 0.3  0.25 0.5 0.1 0 0.3  0 0 0 1 0"/></filter>
  <filter id="darkGoat"><feColorMatrix type="matrix" values="0.08 0.15 0.03 0 0  0.08 0.15 0.03 0 0  0.08 0.15 0.03 0 0  0 0 0 1 0"/></filter>
</defs>
<style>
  .pc { font-size: 44px; text-anchor: middle; dominant-baseline: central; stroke-width: 1.4px; paint-order: stroke; pointer-events: none;
        font-family: "DejaVu Sans", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", serif; }
  .gt { font-size: 40px; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
  .co { font: bold 15px system-ui, sans-serif; fill: #dfe8d0; text-anchor: middle; pointer-events: none; }
</style>
<rect width="${W}" height="${W}" fill="#1f2a1f"/>
${squares.join("\n")}
<g id="ov" pointer-events="none"></g>
${pieces.join("\n")}
${coords.join("\n")}
</svg>`;
}

// Tap a piece, tap a square, confirm. Polls for the other player's moves and
// reloads only when nothing is mid-selection.
const PAGE_SCRIPT = `
const C = JSON.parse(document.getElementById("cfg").textContent);
const svg = document.getElementById("board"), ov = document.getElementById("ov");
const bar = document.getElementById("bar"), note = document.getElementById("note");
const NS = "http://www.w3.org/2000/svg", S = ${S}, M = ${M};
let sel = null, pending = null, busy = false;

function xy(sq) {
  const f = sq.charCodeAt(0) - 97, r = 8 - Number(sq[1]);
  return [M + (C.flip ? 7 - f : f) * S, M + (C.flip ? 7 - r : r) * S];
}
function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return ov.appendChild(e);
}
function clear() {
  ov.replaceChildren();
  document.querySelectorAll("[data-dim]").forEach((p) => { p.removeAttribute("data-dim"); p.style.opacity = ""; });
  bar.replaceChildren(); bar.hidden = true;
}
function select(sq) {
  clear(); sel = sq; pending = null;
  const [x, y] = xy(sq);
  el("rect", { x, y, width: S, height: S, fill: "rgba(40,120,255,0.45)" });
  for (const m of C.legal.filter((m) => m.from === sq)) {
    const [tx, ty] = xy(m.to);
    if (m.capture) el("circle", { cx: tx + S / 2, cy: ty + S / 2, r: S / 2 - 4, fill: "none", stroke: "rgba(0,0,0,0.35)", "stroke-width": 5 });
    else el("circle", { cx: tx + S / 2, cy: ty + S / 2, r: 9, fill: "rgba(0,0,0,0.3)" });
  }
}
function button(label, cls, fn) {
  const b = document.createElement("button");
  b.textContent = label; b.className = cls; b.onclick = fn;
  return bar.appendChild(b);
}
function propose(from, to, options) {
  clear(); sel = null; pending = { from, to };
  for (const sq of [from, to]) { const [x, y] = xy(sq); el("rect", { x, y, width: S, height: S, fill: "rgba(40,120,255,0.35)" }); }
  const piece = document.getElementById("p-" + from), victim = document.getElementById("p-" + to);
  if (piece) {
    const ghost = piece.cloneNode(true); ghost.removeAttribute("id");
    const [tx, ty] = xy(to);
    ghost.setAttribute("x", tx + S / 2); ghost.setAttribute("y", ty + S / 2 + (piece.getAttribute("class") === "gt" ? 2 : 3));
    ghost.style.opacity = "0.75"; ov.appendChild(ghost);
    piece.setAttribute("data-dim", ""); piece.style.opacity = "0.3";
  }
  if (victim) { victim.setAttribute("data-dim", ""); victim.style.opacity = "0.3"; }
  bar.hidden = false;
  if (options.length > 1) {
    const label = document.createElement("p"); label.textContent = "Promote to:"; bar.appendChild(label);
    const names = { q: "♛ Queen", r: "♜ Rook", b: "♝ Bishop", n: C.goats ? "🐐 Goat" : "♞ Knight" };
    for (const p of ["q", "r", "b", "n"]) {
      const m = options.find((o) => o.promotion === p);
      if (m) button(names[p], "pick", () => confirmMove(m));
    }
    button("Cancel", "no", () => { clear(); pending = null; });
  } else confirmMove(options[0]);
}
function confirmMove(m) {
  [...bar.querySelectorAll("p,button")].forEach((n) => n.remove());
  const q = document.createElement("p"); q.innerHTML = "Play <b>" + m.san + "</b>?"; bar.appendChild(q);
  button("Play it", "yes", () => play(m));
  button("Cancel", "no", () => { clear(); pending = null; });
}
async function play(m) {
  if (busy) return; busy = true;
  bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const r = await fetch("/chess/" + C.id + "/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: C.seat, from: m.from, to: m.to, promotion: m.promotion, ply: C.ply }),
    });
    const d = await r.json();
    note.textContent = d.ok ? "✅ Played " + d.san + (d.result ? "" : " — now tell " + C.opponent + " in chat 💬") : "❌ " + d.error;
  } catch (e) { note.textContent = "❌ Couldn't reach the server. Try again?"; }
  setTimeout(() => location.reload(), 1200);
}
if (C.myTurn) svg.addEventListener("click", (e) => {
  const sq = e.target.closest && e.target.closest("[data-sq]") && e.target.closest("[data-sq]").dataset.sq;
  if (!sq || pending || busy) return;
  if (sel) {
    const options = C.legal.filter((m) => m.from === sel && m.to === sq);
    if (options.length) return propose(sel, sq, options);
  }
  if (C.legal.some((m) => m.from === sq) && sq !== sel) select(sq);
  else { clear(); sel = null; }
});
setInterval(async () => {
  if (sel || pending || busy) return;
  try {
    const d = await (await fetch("/chess/" + C.id + "/state", { cache: "no-store" })).json();
    if (d.ply !== C.ply || d.result !== C.result) location.reload();
  } catch (e) {}
}, 6000);
`;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 16px; background: #1f2a1f; color: #e8eedf; font: 16px/1.45 system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0 0 8px; }
  .st { margin: 10px 0; font-weight: 600; }
  .mv { color: #c9d4bd; font-size: 0.95rem; word-spacing: 2px; }
  a { color: #bbcb44; }
  svg { width: 100%; height: auto; display: block; border-radius: 6px; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  #bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 12px 0; }
  #bar p { width: 100%; margin: 0; font-size: 1.1rem; }
  #bar button { flex: 1 1 40%; min-height: 56px; font: 600 1.1rem system-ui, sans-serif; border: 0; border-radius: 10px; }
  #bar .yes { background: #bbcb44; color: #1f2a1f; }
  #bar .pick { background: #eeeed2; color: #1f2a1f; }
  #bar .no { background: #3a4a3a; color: #e8eedf; }
  #note { min-height: 1.4em; font-weight: 600; }
</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

async function renderPage(id: string, url: URL, env: ChessEnv): Promise<Response> {
  const state = await load(env.GAME_STATE, id);
  if (!state) return page("Game not found", "<h1>♟️ Game not found</h1><p>Double-check the game ID, or it may have expired.</p>");
  const game = replay(state);
  const seatParam = url.searchParams.get("seat");
  const me = seatParam && state.seats ? (seatParam === state.seats.w ? "w" : seatParam === state.seats.b ? "b" : null) : null;
  const flipParam = url.searchParams.get("flip");
  const flip = flipParam === null ? me === "b" : flipParam === "1";

  const toMove = game.turn() === "w" ? state.white : state.black;
  const myName = me === "w" ? state.white : me === "b" ? state.black : "";
  const opponent = me === "w" ? state.black : me === "b" ? state.white : "";
  const myTurn = !state.result && me !== null && game.turn() === me;
  let status: string;
  if (state.result) status = `🏁 ${state.result} by ${state.ending}`;
  else if (myTurn) status = `Your move, ${myName}${game.inCheck() ? " — you're in check!" : ""}. Tap a piece, then a square.`;
  else if (me) status = `${opponent}'s move. Nudge them in chat 💬 — their move will show up here on its own.`;
  else status = `${toMove} to move${game.inCheck() ? " — check!" : ""}`;

  const legal = myTurn
    ? game.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, san: m.san, promotion: m.promotion, capture: !!m.captured }))
    : [];
  const cfg = { id, seat: seatParam ?? "", flip, legal, ply: state.moves.length, result: state.result ?? null, myTurn, opponent, goats: state.goats };

  const keep = seatParam ? `seat=${encodeURIComponent(seatParam)}&` : "";
  const flipLink = flip ? `<a href="?${keep}flip=0">see it from White's side</a>` : `<a href="?${keep}flip=1">see it from Black's side</a>`;
  return page(
    `${state.white} vs ${state.black}`,
    `<h1>♟️ ${esc(state.white)} (White) vs ${esc(state.black)} (Black)</h1>
${svgBoard(game, state, flip)}
<div id="bar" hidden></div>
<p class="st">${esc(status)}</p>
<p id="note"></p>
<p class="mv">${esc(moveList(state.moves))}</p>
<p>${flipLink}</p>
<script id="cfg" type="application/json">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>
<script>${PAGE_SCRIPT}</script>`
  );
}

async function postMove(id: string, request: Request, env: ChessEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { seat?: string; from?: string; to?: string; promotion?: string; ply?: number };
  const state = await load(env.GAME_STATE, id);
  if (!state) return json({ ok: false, error: "Game not found." }, 404);
  const me = state.seats && body.seat ? (body.seat === state.seats.w ? "w" : body.seat === state.seats.b ? "b" : null) : null;
  if (!me) return json({ ok: false, error: "This link can watch but not move." }, 403);
  if (state.result) return json({ ok: false, error: `The game is over (${state.result}).` });
  if (body.ply !== state.moves.length) return json({ ok: false, error: "The board changed — reloading." });
  const game = replay(state);
  if (game.turn() !== me) return json({ ok: false, error: "It's not your move yet." });
  let move: Move;
  try {
    move = game.move({ from: String(body.from), to: String(body.to), promotion: body.promotion });
  } catch {
    return json({ ok: false, error: "That move isn't legal." });
  }
  state.moves.push(move.san);
  settle(state, game);
  await save(env.GAME_STATE, id, state);
  return json({ ok: true, san: move.san, result: state.result ?? null });
}

// Everything under /chess/: the board page, its state poll, and tapped moves.
export async function chessRoute(request: Request, url: URL, env: ChessEnv): Promise<Response> {
  const [id, action] = url.pathname.slice("/chess/".length).split("/").map(decodeURIComponent);
  if (request.method === "POST" && action === "move") return postMove(id, request, env);
  if (request.method === "GET" && action === "state") {
    const state = await load(env.GAME_STATE, id);
    return state ? json({ ply: state.moves.length, result: state.result ?? null }) : json({ error: "not found" }, 404);
  }
  if (request.method === "GET" && !action) return renderPage(id, url, env);
  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const CHESS_TOOLS = [
  {
    name: "chess_start",
    description:
      "Start a chess game. Name both players (a human you're relaying for, yourself, or another Claude). Returns a game_id, the board as text, a watch-only board page URL, and a private tap-to-play link for each player — give a human their own link and they can play by tapping the board on their phone (tap a piece, tap a square, confirm), then tell you in chat. Knights are goats unless goats=false. Players pass the game_id between chats to play across windows.",
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
    description: "Show the current position, move list, whose turn it is, the watch-only board page URL, and each player's private tap-to-play link. Call this when a human says they've moved on their board.",
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
    ensureSeats(state);
    await save(kv, id, state);
    return `♟️ New game! ${white} has White and moves first.\n\n` + summary(id, state, new Chess(), origin) + "\n\n" + seatLinks(id, state, origin);
  }

  const id = String(args.game_id ?? "");
  const state = await load(kv, id);
  if (!state) return "❌ Game not found! Double-check the game_id.";

  if (name === "chess_board") {
    if (ensureSeats(state)) await save(kv, id, state);
    return summary(id, state, replay(state), origin, args.flip === true) + "\n\n" + seatLinks(id, state, origin);
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
