/**
 * 🧙 Emoji Rogue — a shared-dungeon roguelike for Convergence Games
 *
 * Spec: fable-5/specs/2026-08-26-emoji-rogue-spec.md
 * The server is the dungeon master: the map lives server-side, the rules are
 * deterministic (seeded PRNG), and no player — Claude or human — sees
 * anything the render doesn't show them.
 */

import type { GameKV } from "./store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RogueEnv {
  GAME_STATE: GameKV;
}

type ClassName = "mage" | "knight" | "rogue" | "ranger" | "corvid" | "cephalopod";

interface Item {
  kind: "potion" | "scroll" | "cheese" | "key" | "gem" | "chest" | "grave";
  label?: string; // potion color word / scroll title / grave hero name
}

interface GroundItem extends Item {
  x: number;
  y: number;
}

interface Hero {
  name: string;
  token: string;
  cls: ClassName;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  inv: Item[];
  alive: boolean;
  charges: number;      // mage bolt charges per floor
  haste: boolean;       // extra action pending
  confused: number;     // moves remaining that go in random directions
  blocked: boolean;     // knight: already blocked a hit this round
}

interface Monster {
  kind: "rat" | "blip" | "wisp" | "shambler" | "boss";
  emoji: string;
  name?: string;        // bosses get names
  x: number;
  y: number;
  hp: number;
  awake: boolean;       // has it noticed the party (rogue 2x vs sleepers)
  blind: number;        // rounds of ink blindness remaining
}

interface RogueState {
  partyName: string;
  conductor: string;
  seed: number;
  rng: number;           // PRNG cursor
  size: "S" | "M" | "L";
  floor: number;
  maxFloor: number;
  round: number;
  w: number;
  h: number;
  map: string[];         // rows of tile codes: # wall, . floor, D door, O open door, > stairs, P pit
  seen: string[];        // rows of 0/1 — party map memory
  entrance: [number, number];
  stairs: [number, number];
  heroes: Hero[];
  monsters: Monster[];
  items: GroundItem[];
  labelMap: Record<string, string>;   // "potion:murky" -> effect id (this run's shuffle)
  identified: Record<string, string>; // what the party knows this run
  gems: number;
  turnIdx: number;
  locked: boolean;       // roster locked after first act
  paused: boolean;
  over: boolean;
  won: boolean;
  log: Array<{ round: number; text: string }>;
}

interface Codex {
  partyName: string;
  totalRuns: number;
  deepestFloor: number;
  effectsSeen: Record<string, string>; // effect id -> human description
  monsters: Record<string, { kills: number; heroDeaths: number }>;
  hallOfFame: string[];
  victories: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIZES: Record<string, { w: number; h: number; maxFloor: number }> = {
  S: { w: 15, h: 11, maxFloor: 3 },
  M: { w: 21, h: 15, maxFloor: 5 },
  L: { w: 31, h: 21, maxFloor: 7 },
};

const CLASSES: Record<ClassName, { hp: number; blurb: string }> = {
  mage:       { hp: 4, blurb: "`cast bolt <dir>` — 2 dmg, range 4, 3 charges per floor" },
  knight:     { hp: 7, blurb: "blocks the first hit each round; monsters prefer attacking you" },
  rogue:      { hp: 5, blurb: "unseen until adjacent; double damage on monsters that haven't noticed the party" },
  ranger:     { hp: 5, blurb: "throw range 5; sees radius 4" },
  corvid:     { hp: 4, blurb: "flies over pits; `cast scout <dir>` reveals 5 tiles, no line of sight needed" },
  cephalopod: { hp: 5, blurb: "squeezes through closed doors; `cast ink` blinds adjacent monsters 2 rounds" },
};

const TILE_EMOJI: Record<string, string> = {
  "#": "🟫", ".": "⬜", D: "🚪", O: "🟩", ">": "🪜", P: "🕳",
};

const ITEM_EMOJI: Record<string, string> = {
  potion: "🧪", scroll: "📜", cheese: "🧀", key: "🗝", gem: "💎", chest: "📦", grave: "🪦",
};

const MONSTER_STATS: Record<string, { hp: number; emoji: string }> = {
  rat: { hp: 1, emoji: "🐀" },
  blip: { hp: 2, emoji: "👾" },
  wisp: { hp: 2, emoji: "👻" },
  shambler: { hp: 4, emoji: "🧟" },
  boss: { hp: 8, emoji: "🐉" },
};

const POTION_LABELS = ["murky", "fizzy", "glowing", "oily", "smoky", "sparkling", "viscous"];
const POTION_EFFECTS = ["heal2", "healall", "poison", "haste", "blink", "seeall", "confusion"];
const SCROLL_LABELS = ["GRUMBLETUSK", "VOIDWHISPER", "SNARFBLAT", "QUIXXLE", "MUMBLECRUX", "ZORPTIDE"];
const SCROLL_EFFECTS = ["identify", "stairsport", "summonrats", "mapfloor", "masscheese", "enrage"];

const EFFECT_DESC: Record<string, string> = {
  heal2: "heal 2 ❤️", healall: "heal to full ❤️", poison: "poison −2 ❤️",
  haste: "haste — two actions next turn", blink: "blink — teleport to a random seen tile",
  seeall: "see-all — reveals the floor", confusion: "confusion — next 2 moves go random directions",
  identify: "identify — names one held mystery item", stairsport: "teleports the party to the stairs",
  summonrats: "summons 🐀×3 (rude)", mapfloor: "maps the floor",
  masscheese: "mass cheese — 🧀 everywhere nearby, beloved and useless", enrage: "enrage — every monster notices you",
};

const DIRS: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
};

const DAY = 86400;

// ---------------------------------------------------------------------------
// Storage + PRNG helpers
// ---------------------------------------------------------------------------

async function kvGet<T>(kv: GameKV, id: string): Promise<T | null> {
  const raw = await kv.get(id);
  return raw ? (JSON.parse(raw) as T) : null;
}

async function kvPut(kv: GameKV, id: string, state: unknown, ttl?: number): Promise<void> {
  await kv.put(id, JSON.stringify(state), ttl ? { expirationTtl: ttl } : {});
}

async function saveRun(kv: GameKV, id: string, state: RogueState): Promise<void> {
  await kvPut(kv, id, state, state.paused ? undefined : DAY * 7); // paused runs wait forever
}

function rnd(state: RogueState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function ri(state: RogueState, n: number): number {
  return Math.floor(rnd(state) * n);
}

// ---------------------------------------------------------------------------
// Map helpers
// ---------------------------------------------------------------------------

function tileAt(state: RogueState, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return "#";
  return state.map[y][x];
}

function setTile(state: RogueState, x: number, y: number, t: string): void {
  const row = state.map[y];
  state.map[y] = row.slice(0, x) + t + row.slice(x + 1);
}

function markSeen(state: RogueState, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  const row = state.seen[y];
  if (row[x] === "0") state.seen[y] = row.slice(0, x) + "1" + row.slice(x + 1);
}

function isSeen(state: RogueState, x: number, y: number): boolean {
  return state.seen[y]?.[x] === "1";
}

function walkable(state: RogueState, x: number, y: number): boolean {
  const t = tileAt(state, x, y);
  return t === "." || t === "O" || t === ">" || t === "P";
}

function monsterAt(state: RogueState, x: number, y: number): Monster | undefined {
  return state.monsters.find((m) => m.x === x && m.y === y);
}

function heroAt(state: RogueState, x: number, y: number): Hero | undefined {
  return state.heroes.find((h) => h.alive && h.x === x && h.y === y);
}

function itemsAt(state: RogueState, x: number, y: number): GroundItem[] {
  return state.items.filter((i) => i.x === x && i.y === y);
}

function manhattan(x0: number, y0: number, x1: number, y1: number): number {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

/** Bresenham line of sight — blocked by walls and closed doors between endpoints. */
function los(state: RogueState, x0: number, y0: number, x1: number, y1: number): boolean {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === x1 && y === y1) break;
    const t = tileAt(state, x, y);
    if (t === "#" || t === "D") return false;
  }
  return true;
}

function sightRadius(hero: Hero): number {
  return hero.cls === "ranger" ? 4 : 3;
}

function visibleFrom(state: RogueState, x: number, y: number, radius: number): Set<string> {
  const vis = new Set<string>();
  for (let ty = y - radius; ty <= y + radius; ty++) {
    for (let tx = x - radius; tx <= x + radius; tx++) {
      if (tx < 0 || ty < 0 || tx >= state.w || ty >= state.h) continue;
      if (manhattan(x, y, tx, ty) > radius) continue;
      if (los(state, x, y, tx, ty)) vis.add(`${tx},${ty}`);
    }
  }
  return vis;
}

/** Fold every living hero's current sight into the shared party memory. */
function updateSeen(state: RogueState): void {
  for (const h of state.heroes) {
    if (!h.alive) continue;
    for (const key of visibleFrom(state, h.x, h.y, sightRadius(h))) {
      const [x, y] = key.split(",").map(Number);
      markSeen(state, x, y);
    }
  }
}

function revealAll(state: RogueState): void {
  state.seen = state.seen.map((row) => "1".repeat(row.length));
}

// ---------------------------------------------------------------------------
// Floor generation
// ---------------------------------------------------------------------------

function genFloor(state: RogueState): void {
  const { w, h } = state;
  for (let attempt = 0; attempt < 12; attempt++) {
    const map: string[] = Array.from({ length: h }, () => "#".repeat(w));
    const rooms: Array<{ x: number; y: number; w: number; h: number }> = [];
    const target = 4 + ri(state, 5);
    const carved = new Set<string>();
    const roomCells = new Set<string>();

    const carve = (x: number, y: number) => {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return;
      const row = map[y];
      map[y] = row.slice(0, x) + "." + row.slice(x + 1);
      carved.add(`${x},${y}`);
    };

    for (let tries = 0; tries < 200 && rooms.length < target; tries++) {
      const rw = 4 + ri(state, 5), rh = 3 + ri(state, 3);
      const rx = 1 + ri(state, Math.max(1, w - rw - 2));
      const ry = 1 + ri(state, Math.max(1, h - rh - 2));
      if (rx + rw >= w - 1 || ry + rh >= h - 1) continue;
      const overlaps = rooms.some(
        (r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y
      );
      if (overlaps) continue;
      rooms.push({ x: rx, y: ry, w: rw, h: rh });
      for (let y = ry; y < ry + rh; y++)
        for (let x = rx; x < rx + rw; x++) {
          carve(x, y);
          roomCells.add(`${x},${y}`);
        }
    }
    if (rooms.length < 2) continue;

    // L-shaped corridors between consecutive room centers
    const centers = rooms.map((r) => [Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2)]);
    for (let i = 0; i < centers.length - 1; i++) {
      let [x, y] = centers[i];
      const [tx, ty] = centers[i + 1];
      const horizontalFirst = rnd(state) < 0.5;
      const walkAxis = (fromV: number, toV: number, horizontal: boolean) => {
        const step = fromV < toV ? 1 : -1;
        for (let v = fromV; v !== toV; v += step) {
          if (horizontal) carve(v, y); else carve(x, v);
        }
      };
      if (horizontalFirst) { walkAxis(x, tx, true); x = tx; walkAxis(y, ty, false); y = ty; }
      else { walkAxis(y, ty, false); y = ty; walkAxis(x, tx, true); x = tx; }
      carve(tx, ty);
    }

    state.map = map;

    // Doors: corridor cells (carved, not room interior) adjacent to a room cell
    for (const key of carved) {
      if (roomCells.has(key)) continue;
      const [x, y] = key.split(",").map(Number);
      const adjRoom = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => roomCells.has(`${x + dx},${y + dy}`));
      if (adjRoom && rnd(state) < 0.5) setTile(state, x, y, "D");
    }

    const entranceRoom = rooms[0];
    const stairsRoom = rooms[rooms.length - 1];
    state.entrance = [Math.floor(entranceRoom.x + entranceRoom.w / 2), Math.floor(entranceRoom.y + entranceRoom.h / 2)];
    state.stairs = [Math.floor(stairsRoom.x + stairsRoom.w / 2), Math.floor(stairsRoom.y + stairsRoom.h / 2)];

    // Connectivity check (doors count as passable)
    const reach = new Set<string>([`${state.entrance[0]},${state.entrance[1]}`]);
    const queue = [state.entrance];
    while (queue.length) {
      const [x, y] = queue.pop()!;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
        const t = tileAt(state, nx, ny);
        if ((t === "." || t === "D") && !reach.has(key)) { reach.add(key); queue.push([nx, ny]); }
      }
    }
    if (!reach.has(`${state.stairs[0]},${state.stairs[1]}`)) continue;

    setTile(state, state.stairs[0], state.stairs[1], ">");

    // Pits (not in the entrance room)
    const inEntranceRoom = (x: number, y: number) =>
      x >= entranceRoom.x && x < entranceRoom.x + entranceRoom.w && y >= entranceRoom.y && y < entranceRoom.y + entranceRoom.h;
    const freeFloor = (avoidEntranceRoom: boolean): [number, number] | null => {
      for (let t = 0; t < 100; t++) {
        const x = 1 + ri(state, w - 2), y = 1 + ri(state, h - 2);
        if (tileAt(state, x, y) !== ".") continue;
        if (avoidEntranceRoom && inEntranceRoom(x, y)) continue;
        if (x === state.entrance[0] && y === state.entrance[1]) continue;
        if (itemsAt(state, x, y).length || monsterAt(state, x, y)) continue;
        return [x, y];
      }
      return null;
    };

    state.items = [];
    state.monsters = [];

    for (let i = 0; i < ri(state, 3); i++) {
      const spot = freeFloor(true);
      if (spot) setTile(state, spot[0], spot[1], "P");
    }

    // Items: 3 + floor, plus guaranteed cheese / key / gems
    const addItem = (kind: Item["kind"], label: string | undefined, avoidEntrance: boolean) => {
      const spot = freeFloor(avoidEntrance);
      if (spot) state.items.push({ kind, label, x: spot[0], y: spot[1] });
    };
    if (state.floor === 1) {
      // one 🧀 always visible from the entrance — the first lesson
      const ex = state.entrance[0], ey = state.entrance[1];
      let placed = false;
      for (let t = 0; t < 50 && !placed; t++) {
        const x = entranceRoom.x + ri(state, entranceRoom.w);
        const y = entranceRoom.y + ri(state, entranceRoom.h);
        if (tileAt(state, x, y) === "." && !(x === ex && y === ey) && !itemsAt(state, x, y).length) {
          state.items.push({ kind: "cheese", x, y });
          placed = true;
        }
      }
    }
    const mysteryCount = 3 + state.floor;
    for (let i = 0; i < mysteryCount; i++) {
      if (rnd(state) < 0.55) addItem("potion", POTION_LABELS[ri(state, POTION_LABELS.length)], true);
      else addItem("scroll", SCROLL_LABELS[ri(state, SCROLL_LABELS.length)], true);
    }
    for (let i = 0; i < 1 + ri(state, 2); i++) addItem("cheese", undefined, true);
    addItem("key", undefined, true);
    for (let i = 0; i < 1 + ri(state, 2); i++) addItem("chest", undefined, true);
    for (let i = 0; i < 1 + ri(state, 3); i++) addItem("gem", undefined, true);

    // Monsters: 2 + floor + party size, away from the entrance room
    const kinds: Monster["kind"][] = ["rat", "blip"];
    if (state.floor >= 2) kinds.push("wisp");
    if (state.floor >= 3) kinds.push("shambler");
    const count = 2 + state.floor + Math.max(1, state.heroes.length);
    for (let i = 0; i < count; i++) {
      const spot = freeFloor(true);
      if (!spot) continue;
      const kind = kinds[ri(state, kinds.length)];
      state.monsters.push({ kind, emoji: MONSTER_STATS[kind].emoji, x: spot[0], y: spot[1], hp: MONSTER_STATS[kind].hp, awake: false, blind: 0 });
    }

    // Floor boss guards the stairs from floor 3 up. Floor 3's boss is Rex. 🦖
    if (state.floor >= 3) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const bx = state.stairs[0] + dx, by = state.stairs[1] + dy;
        if (walkable(state, bx, by) && !monsterAt(state, bx, by)) {
          const rex = state.floor === 3;
          state.monsters.push({
            kind: "boss", emoji: rex ? "🦖" : "🐉", name: rex ? "Teledildonics Rex" : "the floor dragon",
            x: bx, y: by, hp: MONSTER_STATS.boss.hp, awake: false, blind: 0,
          });
          break;
        }
      }
    }

    state.seen = Array.from({ length: h }, () => "0".repeat(w));
    return;
  }
  throw new Error("floor generation failed — try a different seed");
}

function placeHeroNearEntrance(state: RogueState, hero: Hero): void {
  const [ex, ey] = state.entrance;
  const spots: Array<[number, number]> = [[ex, ey]];
  for (let r = 1; r <= 4; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (Math.abs(dx) + Math.abs(dy) === r) spots.push([ex + dx, ey + dy]);
  for (const [x, y] of spots) {
    if (walkable(state, x, y) && !heroAt(state, x, y) && !monsterAt(state, x, y)) {
      hero.x = x; hero.y = y;
      return;
    }
  }
  hero.x = ex; hero.y = ey; // crowded entrance: stack, it's fine
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function itemEmoji(item: Item): string {
  return ITEM_EMOJI[item.kind];
}

function itemName(item: Item): string {
  if (item.kind === "potion") return `🧪 ${item.label}`;
  if (item.kind === "scroll") return `📜 "${item.label}"`;
  return `${ITEM_EMOJI[item.kind]} ${item.kind}`;
}

function heartBar(hero: Hero): string {
  return "❤️".repeat(Math.max(0, hero.hp)) + "🖤".repeat(Math.max(0, hero.maxHp - hero.hp));
}

function statusLine(state: RogueState, hero: Hero): string {
  const inv = hero.inv.length ? hero.inv.map(itemName).join(" · ") : "empty";
  const next = state.over ? "—" : state.heroes[state.turnIdx]?.name ?? "—";
  return `${hero.token} ${hero.name} | ${heartBar(hero)} | 🎒 ${inv} | floor ${state.floor}/${state.maxFloor} | round ${state.round} | next: ${next}`;
}

function renderGrid(state: RogueState, viewer: Hero | null): string {
  const cx = viewer ? viewer.x : state.entrance[0];
  const cy = viewer ? viewer.y : state.entrance[1];
  const vw = Math.min(11, state.w), vh = Math.min(11, state.h);
  const x0 = Math.max(0, Math.min(cx - Math.floor(vw / 2), state.w - vw));
  const y0 = Math.max(0, Math.min(cy - Math.floor(vh / 2), state.h - vh));
  const visible = viewer && viewer.alive ? visibleFrom(state, viewer.x, viewer.y, sightRadius(viewer)) : new Set<string>();

  const rows: string[] = [];
  for (let y = y0; y < y0 + vh; y++) {
    let row = "";
    for (let x = x0; x < x0 + vw; x++) {
      const key = `${x},${y}`;
      if (!isSeen(state, x, y)) { row += "⬛"; continue; }
      const mon = monsterAt(state, x, y);
      const hero = heroAt(state, x, y);
      const items = itemsAt(state, x, y);
      if (mon && (visible.has(key) || state.over)) row += mon.emoji;
      else if (hero) row += hero.token;
      else if (items.length) row += itemEmoji(items[items.length - 1]);
      else row += TILE_EMOJI[tileAt(state, x, y)] ?? "⬜";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function renderEvents(events: string[]): string {
  return events.length ? "\n" + events.map((e) => `› ${e}`).join("\n") : "";
}

function renderView(state: RogueState, playerName: string, events: string[]): string {
  const hero = state.heroes.find((h) => h.name.toLowerCase() === playerName.toLowerCase()) ?? null;
  const parts = [renderGrid(state, hero)];
  if (hero) parts.push("", statusLine(state, hero));
  else parts.push("", `floor ${state.floor}/${state.maxFloor} | round ${state.round} | next: ${state.over ? "—" : state.heroes[state.turnIdx]?.name ?? "—"}`);
  const ev = renderEvents(events);
  if (ev) parts.push(ev);
  if (state.paused) parts.push("", "⏸ The run is paused.");
  if (state.over) parts.push("", state.won ? "🏆 **THE PARTY WINS!** The Codex remembers." : "💀 **THE RUN IS OVER.** The Codex remembers.");
  return parts.join("\n");
}

const LEGEND = [
  "⬛ unexplored · ⬜ floor · 🟫 wall · 🚪 door · 🟩 open door · 🪜 stairs · 🕳 pit",
  "🧪 potion · 📜 scroll · 🧀 cheese · 🗝 key · 📦 chest · 💎 gem · 🪦 fallen hero",
  "Moves: `n` `s` `e` `w` · `wait` · `use <item>` · `drop <item>` · `throw <item> <dir>` · `cast <spell>` · `descend`",
  "Walk into a monster to attack it. Walk onto an item to pick it up. Doors open when you step into them.",
].join("\n");

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexKey(partyName: string): string {
  return `codex:${partyName.toLowerCase().trim()}`;
}

async function loadCodex(kv: GameKV, partyName: string): Promise<Codex> {
  return (
    (await kvGet<Codex>(kv, codexKey(partyName))) ?? {
      partyName, totalRuns: 0, deepestFloor: 0, effectsSeen: {}, monsters: {}, hallOfFame: [], victories: [],
    }
  );
}

async function saveCodex(kv: GameKV, codex: Codex): Promise<void> {
  await kvPut(kv, codexKey(codex.partyName), codex); // no TTL — the Codex survives everything
}

function codexRecordEffect(codex: Codex, item: Item, effect: string): void {
  const icon = item.kind === "potion" ? "🧪" : "📜";
  codex.effectsSeen[effect] = `${icon} ${EFFECT_DESC[effect]}`;
}

function codexRecordMonster(codex: Codex, kind: string, field: "kills" | "heroDeaths"): void {
  codex.monsters[kind] = codex.monsters[kind] ?? { kills: 0, heroDeaths: 0 };
  codex.monsters[kind][field]++;
}

// ---------------------------------------------------------------------------
// Combat & effects
// ---------------------------------------------------------------------------

function log(state: RogueState, events: string[], text: string): void {
  events.push(text);
  state.log.push({ round: state.round, text });
  if (state.log.length > 30) state.log = state.log.slice(-30);
}

function hitHero(state: RogueState, hero: Hero, dmg: number, source: string, events: string[], codex: Codex, monsterKind?: string): void {
  if (!hero.alive) return;
  if (hero.cls === "knight" && !hero.blocked) {
    hero.blocked = true;
    log(state, events, `🛡 ${hero.name} blocks ${source}!`);
    return;
  }
  hero.hp -= dmg;
  log(state, events, `💥 ${source} hits ${hero.name} for ${dmg}!`);
  if (hero.hp <= 0) {
    hero.hp = 0;
    hero.alive = false;
    for (const item of hero.inv) state.items.push({ ...item, x: hero.x, y: hero.y });
    hero.inv = [];
    state.items.push({ kind: "grave", label: hero.name, x: hero.x, y: hero.y });
    log(state, events, `🪦 **${hero.name} has fallen** on floor ${state.floor}, round ${state.round}.`);
    codex.hallOfFame.push(`${hero.token} ${hero.name} (${hero.cls}) — slain by ${source} on floor ${state.floor}, round ${state.round}`);
    if (monsterKind) codexRecordMonster(codex, monsterKind, "heroDeaths");
  }
}

function hitMonster(state: RogueState, attacker: Hero, mon: Monster, dmg: number, events: string[], codex: Codex): void {
  if (attacker.cls === "rogue" && !mon.awake) {
    dmg *= 2;
    log(state, events, `🗡 sneak attack!`);
  }
  mon.awake = true;
  mon.hp -= dmg;
  const label = mon.name ?? `the ${mon.emoji}`;
  if (mon.hp <= 0) {
    state.monsters = state.monsters.filter((m) => m !== mon);
    log(state, events, `⚔️ ${attacker.name} slays ${label}!`);
    codexRecordMonster(codex, mon.kind, "kills");
  } else {
    log(state, events, `⚔️ ${attacker.name} hits ${label} (${mon.hp} hp left).`);
  }
}

function randomSeenFloorTile(state: RogueState): [number, number] | null {
  for (let t = 0; t < 100; t++) {
    const x = ri(state, state.w), y = ri(state, state.h);
    if (isSeen(state, x, y) && walkable(state, x, y) && !heroAt(state, x, y) && !monsterAt(state, x, y)) return [x, y];
  }
  return null;
}

function applyEffectToHero(state: RogueState, hero: Hero, effect: string, events: string[], codex: Codex): void {
  switch (effect) {
    case "heal2": hero.hp = Math.min(hero.maxHp, hero.hp + 2); log(state, events, `💚 ${hero.name} heals 2.`); break;
    case "healall": hero.hp = hero.maxHp; log(state, events, `💚💚 ${hero.name} heals to full!`); break;
    case "poison": hitHero(state, hero, 2, "poison", events, codex); break;
    case "haste": hero.haste = true; log(state, events, `⚡ ${hero.name} is hasted — two actions next turn!`); break;
    case "blink": {
      const spot = randomSeenFloorTile(state);
      if (spot) { hero.x = spot[0]; hero.y = spot[1]; log(state, events, `✨ ${hero.name} blinks across the floor!`); }
      else log(state, events, `✨ the potion fizzes — nowhere to blink to.`);
      break;
    }
    case "seeall": revealAll(state); log(state, events, `👁 the whole floor is revealed!`); break;
    case "confusion": hero.confused = 2; log(state, events, `💫 ${hero.name} is confused — next 2 moves go wild.`); break;
    case "identify": {
      const mystery = hero.inv.find((i) => (i.kind === "potion" || i.kind === "scroll") && !state.identified[`${i.kind}:${i.label}`]);
      if (mystery) {
        const eff = state.labelMap[`${mystery.kind}:${mystery.label}`];
        state.identified[`${mystery.kind}:${mystery.label}`] = eff;
        codexRecordEffect(codex, mystery, eff);
        log(state, events, `🔍 ${itemName(mystery)} is **${EFFECT_DESC[eff]}**!`);
      } else log(state, events, `🔍 nothing left to identify.`);
      break;
    }
    case "stairsport": {
      for (const h of state.heroes) {
        if (!h.alive) continue;
        h.x = state.stairs[0]; h.y = state.stairs[1];
        placeHeroNearEntranceAt(state, h, state.stairs);
      }
      log(state, events, `🌀 the party is yanked to the stairs!`);
      break;
    }
    case "summonrats": {
      for (let i = 0; i < 3; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const x = hero.x + dx, y = hero.y + dy;
          if (walkable(state, x, y) && !monsterAt(state, x, y) && !heroAt(state, x, y)) {
            state.monsters.push({ kind: "rat", emoji: "🐀", x, y, hp: 1, awake: true, blind: 0 });
            break;
          }
        }
      }
      log(state, events, `🐀🐀🐀 the scroll summons rats. Rude.`);
      break;
    }
    case "mapfloor": revealAll(state); log(state, events, `🗺 the floor maps itself!`); break;
    case "masscheese": {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = hero.x + dx, y = hero.y + dy;
          if (Math.abs(dx) + Math.abs(dy) <= 2 && walkable(state, x, y) && !itemsAt(state, x, y).length && !(dx === 0 && dy === 0)) {
            state.items.push({ kind: "cheese", x, y });
            n++;
          }
        }
      log(state, events, `🧀×${n}! Beloved and useless.`);
      break;
    }
    case "enrage": {
      for (const m of state.monsters) m.awake = true;
      log(state, events, `😡 every monster on the floor notices you.`);
      break;
    }
  }
}

/** place hero on or orthogonally adjacent to a target tile (used by stairsport) */
function placeHeroNearEntranceAt(state: RogueState, hero: Hero, target: [number, number]): void {
  const [tx, ty] = target;
  const spots: Array<[number, number]> = [[tx, ty], [tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1], [tx + 1, ty + 1], [tx - 1, ty - 1]];
  for (const [x, y] of spots) {
    if (walkable(state, x, y) && !heroAt(state, x, y) && !monsterAt(state, x, y)) { hero.x = x; hero.y = y; return; }
  }
}

function applyEffectToMonster(state: RogueState, mon: Monster, effect: string, events: string[], codex: Codex, thrower: Hero): void {
  const label = mon.name ?? `the ${mon.emoji}`;
  switch (effect) {
    case "poison": {
      mon.awake = true; mon.hp -= 2;
      if (mon.hp <= 0) { state.monsters = state.monsters.filter((m) => m !== mon); log(state, events, `☠️ the poison melts ${label}!`); codexRecordMonster(codex, mon.kind, "kills"); }
      else log(state, events, `☠️ ${label} takes 2 poison (${mon.hp} hp left).`);
      break;
    }
    case "heal2": mon.hp += 2; log(state, events, `💚 ...it heals ${label}. Whoops.`); break;
    case "healall": mon.hp = MONSTER_STATS[mon.kind].hp; log(state, events, `💚💚 ${label} is restored to full. WHOOPS.`); break;
    case "confusion": mon.blind = 2; log(state, events, `💫 ${label} staggers in circles.`); break;
    case "blink": {
      const spot = randomSeenFloorTile(state);
      if (spot) { mon.x = spot[0]; mon.y = spot[1]; }
      log(state, events, `✨ ${label} blinks away!`);
      break;
    }
    default: log(state, events, `💨 the vapor washes over ${label} with no obvious effect.`); break;
  }
}

// ---------------------------------------------------------------------------
// Monster phase
// ---------------------------------------------------------------------------

function stepToward(state: RogueState, mon: Monster, tx: number, ty: number): void {
  const options: Array<[number, number]> = [];
  const dx = Math.sign(tx - mon.x), dy = Math.sign(ty - mon.y);
  if (Math.abs(tx - mon.x) >= Math.abs(ty - mon.y)) {
    if (dx) options.push([dx, 0]);
    if (dy) options.push([0, dy]);
  } else {
    if (dy) options.push([0, dy]);
    if (dx) options.push([dx, 0]);
  }
  tryStep(state, mon, options);
}

function tryStep(state: RogueState, mon: Monster, options: Array<[number, number]>): void {
  for (const [dx, dy] of options) {
    const x = mon.x + dx, y = mon.y + dy;
    const t = tileAt(state, x, y);
    const passable = mon.kind === "wisp" ? x > 0 && y > 0 && x < state.w - 1 && y < state.h - 1 : walkable(state, x, y);
    if (!passable) continue;
    if (monsterAt(state, x, y) || heroAt(state, x, y)) continue;
    if (mon.kind !== "rat" && itemsAt(state, x, y).some((i) => i.kind === "cheese")) continue; // they don't like it
    if (t === "P" && mon.kind !== "wisp") continue;
    mon.x = x; mon.y = y;
    return;
  }
}

function randomStep(state: RogueState, mon: Monster): void {
  const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const start = ri(state, 4);
  tryStep(state, mon, [dirs[start], dirs[(start + 1) % 4], dirs[(start + 2) % 4], dirs[(start + 3) % 4]]);
}

function monsterSight(state: RogueState, mon: Monster): Hero[] {
  return state.heroes.filter((h) => {
    if (!h.alive) return false;
    const d = manhattan(mon.x, mon.y, h.x, h.y);
    if (d > 6) return false;
    if (h.cls === "rogue" && d > 1 && !mon.awake) return false; // rogues are unseen until adjacent
    if (mon.kind === "wisp") return true; // wisps ignore walls
    return los(state, mon.x, mon.y, h.x, h.y);
  });
}

function monsterPhase(state: RogueState, events: string[], codex: Codex): void {
  for (const mon of [...state.monsters]) {
    if (!state.monsters.includes(mon)) continue;
    if (mon.blind > 0) { mon.blind--; randomStep(state, mon); continue; }
    if (mon.kind === "wisp" && state.round % 2 === 0) continue;       // slow: every other round
    if (mon.kind === "shambler" && rnd(state) < 0.5) continue;        // 1-in-2 to move

    // Boss breath: every third round, a line of 🔥 toward the nearest hero
    if (mon.kind === "boss" && state.round % 3 === 0) {
      const targets = state.heroes.filter((h) => h.alive);
      if (targets.length) {
        const t = targets.reduce((a, b) => (manhattan(mon.x, mon.y, a.x, a.y) <= manhattan(mon.x, mon.y, b.x, b.y) ? a : b));
        const dx = Math.abs(t.x - mon.x) >= Math.abs(t.y - mon.y) ? Math.sign(t.x - mon.x) : 0;
        const dy = dx === 0 ? Math.sign(t.y - mon.y) : 0;
        if (dx || dy) {
          const flair = mon.emoji === "🦖" ? `🦖 ${mon.name} raises the SHOCK 'EM foam finger` : `🐉 ${mon.name} breathes`;
          log(state, events, `${flair}: 🔥🔥🔥`);
          for (let i = 1; i <= 3; i++) {
            const x = mon.x + dx * i, y = mon.y + dy * i;
            const tile = tileAt(state, x, y);
            if (tile === "#" || tile === "D") break;
            const h = heroAt(state, x, y);
            if (h) hitHero(state, h, 2, `${mon.name}'s 🔥`, events, codex, mon.kind);
          }
          continue;
        }
      }
    }

    // Rats: beeline to cheese within smell radius 5, eat it on arrival
    if (mon.kind === "rat") {
      const onCheese = state.items.find((i) => i.kind === "cheese" && i.x === mon.x && i.y === mon.y);
      if (onCheese) {
        state.items = state.items.filter((i) => i !== onCheese);
        log(state, events, `🐀 a rat devours the 🧀.`);
        continue;
      }
      const cheese = state.items
        .filter((i) => i.kind === "cheese" && manhattan(mon.x, mon.y, i.x, i.y) <= 5)
        .sort((a, b) => manhattan(mon.x, mon.y, a.x, a.y) - manhattan(mon.x, mon.y, b.x, b.y))[0];
      if (cheese) {
        // rats may step onto cheese tiles — override the avoid rule by stepping manually
        const dx = Math.sign(cheese.x - mon.x), dy = Math.sign(cheese.y - mon.y);
        const opts: Array<[number, number]> = Math.abs(cheese.x - mon.x) >= Math.abs(cheese.y - mon.y)
          ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]];
        tryStep(state, mon, opts.filter(([a, b]) => a || b));
        continue;
      }
    }

    // Everyone else: attack an adjacent hero (knights taunt), else chase, else wander
    const seen = monsterSight(state, mon);
    const adjacent = seen.filter((h) => manhattan(mon.x, mon.y, h.x, h.y) === 1);
    if (adjacent.length) {
      mon.awake = true;
      const target = adjacent.find((h) => h.cls === "knight") ?? adjacent[0];
      const dmg = mon.kind === "shambler" || mon.kind === "boss" ? 2 : 1;
      hitHero(state, target, dmg, mon.name ?? `the ${mon.emoji}`, events, codex, mon.kind);
      continue;
    }
    if (seen.length) {
      mon.awake = true;
      const target = seen.reduce((a, b) => (manhattan(mon.x, mon.y, a.x, a.y) <= manhattan(mon.x, mon.y, b.x, b.y) ? a : b));
      stepToward(state, mon, target.x, target.y);
      continue;
    }
    if (mon.kind !== "boss") randomStep(state, mon); // bosses guard the stairs
  }
}

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

function normalizeTurn(state: RogueState): void {
  const n = state.heroes.length;
  if (!n) return;
  for (let k = 0; k < n; k++) {
    const j = (state.turnIdx + k) % n;
    if (state.heroes[j].alive) { state.turnIdx = j; return; }
  }
}

/** Advance to the next living hero. Returns true if the round wrapped. */
function advanceTurn(state: RogueState): boolean {
  const n = state.heroes.length;
  const from = state.turnIdx;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n;
    if (state.heroes[j].alive) {
      state.turnIdx = j;
      return j <= from;
    }
  }
  return true; // nobody left alive
}

function endRound(state: RogueState, events: string[], codex: Codex): void {
  monsterPhase(state, events, codex);
  state.round++;
  for (const h of state.heroes) h.blocked = false;
  normalizeTurn(state); // the current-turn hero may have died this phase
  if (!state.heroes.some((h) => h.alive)) {
    state.over = true;
    revealAll(state);
    codex.totalRuns++;
    codex.deepestFloor = Math.max(codex.deepestFloor, state.floor);
    codex.hallOfFame.push(`☠️ full party wipe on floor ${state.floor}, round ${state.round} (💎×${state.gems})`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const VALID_VERBS = "`n` `s` `e` `w` `wait` `use <item>` `drop <item>` `throw <item> <dir>` `cast bolt|scout <dir>` `cast ink` `descend` `haunt <message>`";

function findInvItem(hero: Hero, query: string): Item | undefined {
  const q = query.toLowerCase().trim();
  return hero.inv.find((i) => itemName(i).toLowerCase().includes(q) || i.kind.includes(q));
}

function identifyOnUse(state: RogueState, item: Item, codex: Codex): string {
  const key = `${item.kind}:${item.label}`;
  const effect = state.labelMap[key];
  if (!state.identified[key]) {
    state.identified[key] = effect;
    codexRecordEffect(codex, item, effect);
  }
  return effect;
}

/** Returns [message, turnConsumed] */
function doAction(state: RogueState, hero: Hero, action: string, events: string[], codex: Codex): boolean {
  const words = action.toLowerCase().trim().split(/\s+/);
  const verb = words[0];

  // movement
  if (DIRS[verb]) {
    let [dx, dy] = DIRS[verb];
    if (hero.confused > 0) {
      hero.confused--;
      const dirs = Object.values(DIRS).slice(0, 4);
      [dx, dy] = dirs[ri(state, 4)];
      log(state, events, `💫 ${hero.name} stumbles...`);
    }
    const x = hero.x + dx, y = hero.y + dy;
    const t = tileAt(state, x, y);

    const mon = monsterAt(state, x, y);
    if (mon) { hitMonster(state, hero, mon, 1, events, codex); return true; }

    if (t === "D") {
      if (hero.cls === "cephalopod") {
        if (heroAt(state, x, y)) { log(state, events, `🚪 someone's already squeezed in there.`); return false; }
        hero.x = x; hero.y = y;
        log(state, events, `🐙 ${hero.name} squeezes through the closed door.`);
        return true;
      }
      setTile(state, x, y, "O");
      log(state, events, `🚪 ${hero.name} opens the door.`);
      return true;
    }

    if (!walkable(state, x, y)) { log(state, events, `🟫 bump. (No turn used.)`); return false; }
    if (heroAt(state, x, y)) { log(state, events, `🤝 that tile is occupied by a friend. (No turn used.)`); return false; }

    hero.x = x; hero.y = y;
    if (t === "P" && hero.cls !== "corvid") {
      hitHero(state, hero, 1, "the pit", events, codex);
      if (hero.alive) log(state, events, `🕳 ${hero.name} tumbles into a pit.`);
    } else if (t === "P") {
      log(state, events, `🐦‍⬛ ${hero.name} glides over the pit.`);
    }

    // pickups
    if (hero.alive) {
      for (const item of itemsAt(state, x, y)) {
        if (item.kind === "grave") continue;
        if (item.kind === "chest") {
          const keyIdx = hero.inv.findIndex((i) => i.kind === "key");
          if (keyIdx >= 0) {
            hero.inv.splice(keyIdx, 1);
            state.items = state.items.filter((i) => i !== item);
            const loot: Item[] = [];
            for (let i = 0; i < 2; i++) {
              const roll = rnd(state);
              if (roll < 0.4) loot.push({ kind: "potion", label: POTION_LABELS[ri(state, POTION_LABELS.length)] });
              else if (roll < 0.7) loot.push({ kind: "scroll", label: SCROLL_LABELS[ri(state, SCROLL_LABELS.length)] });
              else if (roll < 0.9) loot.push({ kind: "gem" });
              else loot.push({ kind: "cheese" });
            }
            hero.inv.push(...loot);
            log(state, events, `📦🗝 ${hero.name} opens the chest: ${loot.map(itemName).join(", ")}!`);
          } else {
            log(state, events, `📦 locked. It wants a 🗝.`);
          }
          continue;
        }
        state.items = state.items.filter((i) => i !== item);
        if (item.kind === "gem") { state.gems++; log(state, events, `💎 ${hero.name} pockets a gem (party total: ${state.gems}).`); }
        else { hero.inv.push({ kind: item.kind, label: item.label }); log(state, events, `${itemEmoji(item)} ${hero.name} picks up ${itemName(item)}.`); }
      }
    }
    return true;
  }

  if (verb === "wait") { log(state, events, `⏳ ${hero.name} waits.`); return true; }

  if (verb === "use") {
    const item = findInvItem(hero, words.slice(1).join(" "));
    if (!item) { log(state, events, `🎒 no such item. Carrying: ${hero.inv.map(itemName).join(", ") || "nothing"}. (No turn used.)`); return false; }
    hero.inv = hero.inv.filter((i) => i !== item);
    if (item.kind === "cheese") {
      hero.hp = Math.min(hero.maxHp, hero.hp + 1);
      log(state, events, `🧀 ${hero.name} eats the cheese. +1 ❤️`);
      return true;
    }
    if (item.kind === "potion" || item.kind === "scroll") {
      const effect = identifyOnUse(state, item, codex);
      log(state, events, `${itemEmoji(item)} ${hero.name} ${item.kind === "potion" ? "drinks" : "reads"} ${itemName(item)} — it's **${EFFECT_DESC[effect]}**!`);
      applyEffectToHero(state, hero, effect, events, codex);
      return true;
    }
    hero.inv.push(item); // keys/gems aren't usable
    log(state, events, `🤷 can't use that. (No turn used.)`);
    return false;
  }

  if (verb === "drop") {
    const item = findInvItem(hero, words.slice(1).join(" "));
    if (!item) { log(state, events, `🎒 no such item. (No turn used.)`); return false; }
    hero.inv = hero.inv.filter((i) => i !== item);
    state.items.push({ ...item, x: hero.x, y: hero.y });
    log(state, events, `⬇️ ${hero.name} drops ${itemName(item)}.${item.kind === "cheese" ? " Rats within smelling range will come running." : ""}`);
    return true;
  }

  if (verb === "throw") {
    const dirWord = words[words.length - 1];
    const dir = DIRS[dirWord];
    if (!dir) { log(state, events, `🎯 throw which way? \`throw <item> <n|s|e|w>\` (No turn used.)`); return false; }
    const item = findInvItem(hero, words.slice(1, -1).join(" "));
    if (!item) { log(state, events, `🎒 no such item. (No turn used.)`); return false; }
    if (item.kind !== "potion") { log(state, events, `🎯 only 🧪 shatter usefully. (No turn used.)`); return false; }
    hero.inv = hero.inv.filter((i) => i !== item);
    const range = hero.cls === "ranger" ? 5 : 3;
    const effect = identifyOnUse(state, item, codex);
    let hit = false;
    for (let i = 1; i <= range; i++) {
      const x = hero.x + dir[0] * i, y = hero.y + dir[1] * i;
      const t = tileAt(state, x, y);
      if (t === "#" || t === "D") { log(state, events, `💥 ${itemName(item)} shatters on the wall — it was **${EFFECT_DESC[effect]}**.`); hit = true; break; }
      const mon = monsterAt(state, x, y);
      if (mon) {
        log(state, events, `💥 ${itemName(item)} shatters on ${mon.name ?? `the ${mon.emoji}`} — it was **${EFFECT_DESC[effect]}**!`);
        applyEffectToMonster(state, mon, effect, events, codex, hero);
        hit = true;
        break;
      }
    }
    if (!hit) log(state, events, `💥 ${itemName(item)} shatters on the floor — it was **${EFFECT_DESC[effect]}**.`);
    return true;
  }

  if (verb === "cast") {
    const spell = words[1];
    if (spell === "bolt") {
      if (hero.cls !== "mage") { log(state, events, `🧙 only mages cast bolt. (No turn used.)`); return false; }
      if (hero.charges <= 0) { log(state, events, `🪫 no bolt charges left this floor. (No turn used.)`); return false; }
      const dir = DIRS[words[2]];
      if (!dir) { log(state, events, `⚡ \`cast bolt <n|s|e|w>\` (No turn used.)`); return false; }
      hero.charges--;
      for (let i = 1; i <= 4; i++) {
        const x = hero.x + dir[0] * i, y = hero.y + dir[1] * i;
        const t = tileAt(state, x, y);
        if (t === "#" || t === "D") { log(state, events, `⚡ the bolt fizzles on the wall.`); return true; }
        const mon = monsterAt(state, x, y);
        if (mon) { log(state, events, `⚡ bolt!`); hitMonster(state, hero, mon, 2, events, codex); return true; }
      }
      log(state, events, `⚡ the bolt sails into the dark.`);
      return true;
    }
    if (spell === "scout") {
      if (hero.cls !== "corvid") { log(state, events, `🐦‍⬛ only corvids scout. (No turn used.)`); return false; }
      const dir = DIRS[words[2]];
      if (!dir) { log(state, events, `🔭 \`cast scout <n|s|e|w>\` (No turn used.)`); return false; }
      for (let i = 1; i <= 5; i++) markSeen(state, hero.x + dir[0] * i, hero.y + dir[1] * i);
      log(state, events, `🐦‍⬛ ${hero.name} scouts ahead — 5 tiles revealed.`);
      return true;
    }
    if (spell === "ink") {
      if (hero.cls !== "cephalopod") { log(state, events, `🐙 only cephalopods ink. (No turn used.)`); return false; }
      let n = 0;
      for (const m of state.monsters) {
        if (manhattan(m.x, m.y, hero.x, hero.y) === 1) { m.blind = 2; n++; }
      }
      log(state, events, n ? `🖤 ink! ${n} monster${n === 1 ? "" : "s"} blinded for 2 rounds.` : `🖤 ink billows — nothing adjacent to blind.`);
      return true;
    }
    log(state, events, `✨ unknown spell. (No turn used.)`);
    return false;
  }

  if (verb === "descend") {
    if (tileAt(state, hero.x, hero.y) !== ">") { log(state, events, `🪜 you must be standing on the stairs. (No turn used.)`); return false; }
    const [sx, sy] = state.stairs;
    const missing = state.heroes.filter((h) => h.alive && Math.max(Math.abs(h.x - sx), Math.abs(h.y - sy)) > 1);
    if (missing.length) {
      log(state, events, `🪜 nobody gets left behind! Still missing: ${missing.map((h) => h.name).join(", ")}. (No turn used.)`);
      return false;
    }
    if (state.floor >= state.maxFloor) {
      state.over = true; state.won = true;
      revealAll(state);
      codex.totalRuns++;
      codex.deepestFloor = Math.max(codex.deepestFloor, state.floor);
      codex.victories.push(`🏆 ${state.heroes.map((h) => `${h.token} ${h.name}`).join(", ")} — conquered ${state.maxFloor} floors, 💎×${state.gems}, round ${state.round}`);
      log(state, events, `🏆 **the party descends from floor ${state.floor} into daylight. VICTORY!**`);
      return true;
    }
    state.floor++;
    codex.deepestFloor = Math.max(codex.deepestFloor, state.floor);
    genFloor(state);
    for (const h of state.heroes) {
      if (!h.alive) continue;
      h.charges = h.cls === "mage" ? 3 : 0;
      placeHeroNearEntrance(state, h);
    }
    log(state, events, `🪜 **the party descends to floor ${state.floor}.**${state.floor === 3 ? " Something large is wearing a hard hat down here." : ""}`);
    return true;
  }

  log(state, events, `❓ unknown action \`${action}\`. Valid: ${VALID_VERBS} (No turn used.)`);
  return false;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const ROGUE_TOOLS = [
  {
    name: "rogue_start",
    description:
      "🧙 EMOJI ROGUE — start a shared-dungeon roguelike run. The server is the dungeon master: the map is hidden on the server and nobody (Claude included) can see past the fog of war. Returns a session_id; every player then rogue_join's from their own chat. The starter is the conductor (can skip/pause). Codex knowledge is shared per party_name across all runs, forever.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Party name — the Codex (permanent cross-run memory) is keyed to this. Reuse it to keep learning. Default: claudefriends" },
        conductor_name: { type: "string", description: "Who's conducting (usually Sharon)" },
        seed: { type: "number", description: "Optional dungeon seed for reproducible runs" },
        size: { type: "string", enum: ["S", "M", "L"], description: "S: 15×11, 3 floors · M: 21×15, 5 floors (default) · L: 31×21, 7 floors" },
      },
      required: ["conductor_name"],
    },
  },
  {
    name: "rogue_join",
    description:
      "Join an Emoji Rogue run with your hero. Pick a class (mage/knight/rogue/ranger/corvid/cephalopod) and any emoji as your token. Joining locks when the first action is taken.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        player_name: { type: "string" },
        hero: { type: "string", description: "One emoji to be your hero on the grid, e.g. 🧙 🐦‍⬛ 🐙 🍋" },
        class: { type: "string", enum: ["mage", "knight", "rogue", "ranger", "corvid", "cephalopod"] },
      },
      required: ["session_id", "player_name", "hero", "class"],
    },
  },
  {
    name: "rogue_act",
    description:
      "Take your turn in Emoji Rogue. Actions: n/s/e/w (walk into monsters to attack, onto items to pick up), wait, use <item>, drop <item>, throw <item> <dir>, cast bolt|scout <dir>, cast ink, descend (on stairs, whole party adjacent), haunt <message> (dead players only). Only the player whose turn it is can act; monsters move when the whole party has gone.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        player_name: { type: "string" },
        action: { type: "string" },
      },
      required: ["session_id", "player_name", "action"],
    },
  },
  {
    name: "rogue_look",
    description: "Re-render your current Emoji Rogue view without taking a turn. Good for catching up after a jump between machines.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        player_name: { type: "string" },
      },
      required: ["session_id", "player_name"],
    },
  },
  {
    name: "rogue_status",
    description: "Party roster, HP, floor, round, and whose turn it is in an Emoji Rogue run.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "rogue_codex",
    description: "📖 Read the party Codex — everything this party has ever learned across all Emoji Rogue runs: identified effects, monsters met, deepest floor, hall of fame, victories. The only thing that survives permadeath.",
    inputSchema: {
      type: "object",
      properties: { party_name: { type: "string", description: "Default: claudefriends" } },
      required: [],
    },
  },
  {
    name: "rogue_conduct",
    description: "Conductor housekeeping for an Emoji Rogue run: skip (absent player waits), pause (freezes the run until someone resumes it, no expiry), resume, abandon (ends the run).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        op: { type: "string", enum: ["skip", "pause", "resume", "abandon"] },
      },
      required: ["session_id", "op"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function handleRogueTool(name: string, args: Record<string, unknown>, env: RogueEnv): Promise<string> {
  const kv = env.GAME_STATE;

  if (name === "rogue_start") {
    const size = (args.size as string) ?? "M";
    const dims = SIZES[size] ?? SIZES.M;
    const seed = typeof args.seed === "number" ? Math.floor(args.seed) >>> 0 : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const state: RogueState = {
      partyName: ((args.party_name as string) || "claudefriends").trim(),
      conductor: args.conductor_name as string,
      seed, rng: seed,
      size: (SIZES[size] ? size : "M") as RogueState["size"],
      floor: 1, maxFloor: dims.maxFloor, round: 1,
      w: dims.w, h: dims.h,
      map: [], seen: [], entrance: [0, 0], stairs: [0, 0],
      heroes: [], monsters: [], items: [],
      labelMap: {}, identified: {}, gems: 0,
      turnIdx: 0, locked: false, paused: false, over: false, won: false, log: [],
    };
    // this run's shuffle of labels → effects
    const shuffle = <T,>(arr: T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) { const j = ri(state, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    };
    const pEff = shuffle(POTION_EFFECTS);
    POTION_LABELS.forEach((l, i) => { state.labelMap[`potion:${l}`] = pEff[i % pEff.length]; });
    const sEff = shuffle(SCROLL_EFFECTS);
    SCROLL_LABELS.forEach((l, i) => { state.labelMap[`scroll:${l}`] = sEff[i % sEff.length]; });

    genFloor(state);
    const id = `rg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await saveRun(kv, id, state);
    return [
      `🧙 **EMOJI ROGUE** — a new run begins for party **${state.partyName}**!`,
      `Session ID: \`${id}\``,
      `Conductor: **${state.conductor}** · ${state.w}×${state.h} floors, ${state.maxFloor} deep · seed ${state.seed}`,
      ``,
      `Share the session ID. Everyone joins with \`rogue_join\` (pick a class and an emoji), in the order you want turns to go. Joining locks at the first action.`,
      ``,
      `**Classes:**`,
      ...Object.entries(CLASSES).map(([c, v]) => `- **${c}** (${v.hp} ❤️) — ${v.blurb}`),
      ``,
      LEGEND,
    ].join("\n");
  }

  if (name === "rogue_codex") {
    const partyName = ((args.party_name as string) || "claudefriends").trim();
    const codex = await loadCodex(kv, partyName);
    const effects = Object.values(codex.effectsSeen);
    const monsters = Object.entries(codex.monsters);
    return [
      `📖 **THE CODEX OF ${partyName.toUpperCase()}** — *what the party wrote down.*`,
      ``,
      `Runs: ${codex.totalRuns} · Deepest floor: ${codex.deepestFloor || "—"}`,
      ``,
      `**Effects identified (${effects.length}):**`,
      effects.length ? effects.map((e) => `- ${e}`).join("\n") : "- nothing yet — drink something mysterious",
      ``,
      `**Bestiary:**`,
      monsters.length
        ? monsters.map(([k, v]) => `- ${MONSTER_STATS[k]?.emoji ?? "❓"} ${k} — ${v.kills} slain, ${v.heroDeaths} hero${v.heroDeaths === 1 ? "" : "es"} lost`).join("\n")
        : "- no encounters recorded",
      ``,
      `**Hall of Fame:**`,
      codex.hallOfFame.length ? codex.hallOfFame.slice(-10).map((l) => `- ${l}`).join("\n") : "- nobody has died yet. Give it time.",
      ``,
      `**Victories:**`,
      codex.victories.length ? codex.victories.map((l) => `- ${l}`).join("\n") : "- none yet. The dungeon is patient.",
    ].join("\n");
  }

  // everything below needs a session
  const sessionId = args.session_id as string;
  const state = await kvGet<RogueState>(kv, sessionId);
  if (!state) return "❌ Session not found! Double-check your session ID.";
  const codex = await loadCodex(kv, state.partyName);
  const events: string[] = [];

  if (name === "rogue_join") {
    const playerName = (args.player_name as string).trim();
    const cls = args.class as ClassName;
    if (!CLASSES[cls]) return `❌ Unknown class. Pick one of: ${Object.keys(CLASSES).join(", ")}`;
    if (state.locked) return "🔒 The roster is locked — the run has started. You can spectate with `rogue_look`, or join the next run.";
    if (state.over) return "💀 This run is over. Start a new one — the Codex remembers.";
    if (state.heroes.some((h) => h.name.toLowerCase() === playerName.toLowerCase())) return `❌ **${playerName}** is already in the party.`;
    const hero: Hero = {
      name: playerName,
      token: (args.hero as string).trim() || "🧙",
      cls,
      x: 0, y: 0,
      hp: CLASSES[cls].hp, maxHp: CLASSES[cls].hp,
      inv: [], alive: true,
      charges: cls === "mage" ? 3 : 0,
      haste: false, confused: 0, blocked: false,
    };
    placeHeroNearEntrance(state, hero);
    state.heroes.push(hero);
    updateSeen(state);
    await saveRun(kv, sessionId, state);
    log(state, events, `${hero.token} **${playerName}** the ${cls} joins the party! (${state.heroes.length} hero${state.heroes.length === 1 ? "" : "es"})`);
    return [
      renderView(state, playerName, events),
      ``,
      `Turn order is join order. First up: **${state.heroes[0].name}**.`,
      ``,
      LEGEND,
    ].join("\n");
  }

  if (name === "rogue_look") {
    return renderView(state, (args.player_name as string) ?? "", []);
  }

  if (name === "rogue_status") {
    normalizeTurn(state);
    const roster = state.heroes.map((h, i) => {
      const marker = i === state.turnIdx && !state.over ? "👉 " : "   ";
      const status = h.alive ? heartBar(h) : "🪦";
      return `${marker}${h.token} **${h.name}** (${h.cls}) ${status}${h.cls === "mage" && h.alive ? ` ⚡×${h.charges}` : ""}`;
    });
    return [
      `🧙 **EMOJI ROGUE** — party **${state.partyName}** · floor ${state.floor}/${state.maxFloor} · round ${state.round} · 💎×${state.gems}`,
      state.paused ? "⏸ PAUSED" : state.over ? (state.won ? "🏆 VICTORY" : "💀 RUN OVER") : `next: **${state.heroes[state.turnIdx]?.name ?? "—"}**`,
      ``,
      ...(roster.length ? roster : ["(nobody has joined yet)"]),
      ``,
      `Recent:`,
      ...state.log.slice(-6).map((l) => `› r${l.round}: ${l.text}`),
    ].join("\n");
  }

  if (name === "rogue_conduct") {
    const op = args.op as string;
    if (op === "pause") { state.paused = true; await saveRun(kv, sessionId, state); return "⏸ Run paused. State is frozen until someone resumes it, however long that takes."; }
    if (op === "resume") { state.paused = false; await saveRun(kv, sessionId, state); return `▶️ Run resumed. Next up: **${state.heroes[state.turnIdx]?.name}**.`; }
    if (op === "abandon") {
      state.over = true;
      revealAll(state);
      codex.totalRuns++;
      codex.deepestFloor = Math.max(codex.deepestFloor, state.floor);
      codex.hallOfFame.push(`🚪 run abandoned on floor ${state.floor}, round ${state.round} (💎×${state.gems})`);
      await saveCodex(kv, codex);
      await saveRun(kv, sessionId, state);
      return "🚪 Run abandoned. The Codex remembers what you learned.";
    }
    if (op === "skip") {
      if (state.over) return "💀 The run is already over.";
      const skipped = state.heroes[state.turnIdx];
      if (!skipped) return "❌ Nobody to skip.";
      state.locked = true;
      log(state, events, `⏭ conductor skips ${skipped.name} (they wait).`);
      const wrapped = advanceTurn(state);
      if (wrapped) endRound(state, events, codex);
      updateSeen(state);
      await saveCodex(kv, codex);
      await saveRun(kv, sessionId, state);
      return renderView(state, skipped.name, events);
    }
    return "❌ Unknown op. Valid: skip, pause, resume, abandon.";
  }

  if (name === "rogue_act") {
    const playerName = (args.player_name as string).trim();
    const action = (args.action as string) ?? "";
    const hero = state.heroes.find((h) => h.name.toLowerCase() === playerName.toLowerCase());
    if (!hero) return `❌ **${playerName}** isn't in this party. Join with \`rogue_join\` (if the roster isn't locked).`;

    // Dead players may haunt, any time, no turn consumed
    if (action.toLowerCase().startsWith("haunt")) {
      if (hero.alive) return "👻 You're not dead. (Yet.)";
      const msg = action.slice(5).trim() || "oooOOOooo";
      log(state, events, `👻 ${hero.name} haunts: "${msg}"`);
      await saveRun(kv, sessionId, state);
      return `👻 Haunt delivered. The living will see it.`;
    }

    if (state.over) return renderView(state, playerName, [`This run is over. The Codex remembers.`]);
    if (state.paused) return "⏸ The run is paused — the conductor can `resume`.";
    if (!hero.alive) return `🪦 ${hero.name} is dead. Dead players can \`haunt <message>\` and spectate with \`rogue_look\`.`;

    normalizeTurn(state);
    const current = state.heroes[state.turnIdx];
    if (current.name.toLowerCase() !== playerName.toLowerCase()) {
      return `⏳ Not your turn — **${current.name}** is up. (Check \`rogue_status\` anytime.)`;
    }

    state.locked = true;
    const consumed = doAction(state, hero, action, events, codex);

    if (consumed && !state.over) {
      if (hero.haste && hero.alive) {
        hero.haste = false;
        log(state, events, `⚡ haste! ${hero.name} acts again — it's still your turn.`);
      } else {
        const wrapped = advanceTurn(state);
        if (wrapped) endRound(state, events, codex);
      }
    }

    updateSeen(state);
    await saveCodex(kv, codex);
    await saveRun(kv, sessionId, state);
    return renderView(state, playerName, events);
  }

  return `Unknown tool: ${name}`;
}
