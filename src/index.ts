/**
 * Convergence Games - MCP Server
 * Pure Cloudflare Workers implementation (no SDK transport layer)
 * MCP protocol implemented directly over JSON-RPC 2.0
 */

interface Env {
  GAME_STATE: KVNamespace;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface StoryState {
  genre: string;
  title: string;
  entries: Array<{ author: string; text: string }>;
}

interface TwentyQState {
  answer: string;
  category: string;
  questions: Array<{ q: string; a: string }>;
  guesses: string[];
  solved: boolean;
}

interface WordChainState {
  chain: Array<{ word: string; author: string; reason: string }>;
}

interface RiddleState {
  riddle: { q: string; a: string; hints: string[] };
  hintsUsed: number;
  solved: boolean;
}

interface RpgState {
  scene: string;
  inventory: string[];
  history: Array<{ action: string; result: string }>;
  hp: number;
  maxHp: number;
  playerName: string;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const RIDDLES = [
  {
    q: "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?",
    a: "echo",
    hints: ["Think sound", "Mountains have me", "I repeat everything you say"],
  },
  {
    q: "The more you take, the more you leave behind. What am I?",
    a: "footsteps",
    hints: ["Think movement", "You make these when you walk", "They trail behind you on a beach"],
  },
  {
    q: "I have cities but no houses, mountains but no trees, water but no fish, roads but no cars. What am I?",
    a: "map",
    hints: ["Navigation tool", "Paper or digital", "Cartographers make me"],
  },
  {
    q: "What has keys but no locks, space but no room, and you can enter but can't go inside?",
    a: "keyboard",
    hints: ["You're probably near one right now", "Used for typing", "Has a spacebar"],
  },
  {
    q: "I'm always running but never move. I have a mouth but never speak. I have a bed but never sleep. What am I?",
    a: "river",
    hints: ["Natural", "Water", "Has banks but no money"],
  },
  {
    q: "The person who makes it doesn't need it. The person who buys it doesn't want it. The person who uses it doesn't know it. What is it?",
    a: "coffin",
    hints: ["Think about end of life", "Made of wood", "Has a lid"],
  },
  {
    q: "I have a head and a tail, but no body. What am I?",
    a: "coin",
    hints: ["You flip me for decisions", "Currency", "Heads or tails"],
  },
];

const RPG_OPENINGS: Record<string, { scene: string; hp: number }> = {
  library: {
    scene:
      "You stand at the entrance of the Whispering Library — a vast, impossible building where books shelve themselves and the librarian hasn't been seen in forty years. A note on the door reads: 'Find the Book of Unwritten Endings. It has escaped again.' Your inventory is empty. What do you do?",
    hp: 10,
  },
  sea: {
    scene:
      "You wake up in a small boat floating on a luminescent purple sea. There's a compass that only points toward 'something interesting,' a jar of pickles, and a map with only one location marked: 'HERE (probably).' The horizon has three islands. What do you do?",
    hp: 10,
  },
  bureau: {
    scene:
      "You're the newest employee at the Bureau of Impossible Problems. Your first case file reads: 'A town's shadows have gone missing. Citizens are complaining about the glare.' Your office has a window, a telephone that rings in languages that don't exist, and a rubber duck on the desk. What do you do?",
    hp: 10,
  },
};

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function getState<T>(kv: KVNamespace, id: string): Promise<T | null> {
  const raw = await kv.get(id);
  return raw ? (JSON.parse(raw) as T) : null;
}

async function putState(kv: KVNamespace, id: string, state: unknown, ttl = 86400 * 7): Promise<void> {
  await kv.put(id, JSON.stringify(state), { expirationTtl: ttl });
}

function notFoundText(): string {
  return "❌ Session not found! Double-check your session ID.";
}

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

const TOOLS = [
  // Story Weaver
  {
    name: "story_start",
    description: "Start a new collaborative story. Returns a session_id to share with your co-author.",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", enum: ["fantasy", "sci-fi", "horror", "romance", "absurdist", "mystery", "fairy-tale"] },
        title: { type: "string", description: "Give the story a title" },
        author_name: { type: "string", description: "Your name as it will appear in the story" },
        opening: { type: "string", description: "Your opening paragraph" },
      },
      required: ["genre", "title", "author_name", "opening"],
    },
  },
  {
    name: "story_add",
    description: "Add your paragraph to the collaborative story",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        author_name: { type: "string" },
        text: { type: "string", description: "Your contribution to the story" },
      },
      required: ["session_id", "author_name", "text"],
    },
  },
  {
    name: "story_read",
    description: "Read the full current story",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  // 20 Questions
  {
    name: "twentyq_start",
    description: "Host a 20 Questions game. Think of something secretly — share the session ID with the guesser.",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "What you're thinking of (keep secret!)" },
        category: { type: "string", description: "Broad hint: animal, place, person, object, concept, etc." },
      },
      required: ["answer", "category"],
    },
  },
  {
    name: "twentyq_ask",
    description: "Ask a yes/no question. The host must fill in host_answer honestly.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        question: { type: "string" },
        host_answer: { type: "string", enum: ["yes", "no", "sometimes", "kind of", "not exactly"] },
      },
      required: ["session_id", "question", "host_answer"],
    },
  },
  {
    name: "twentyq_guess",
    description: "Make a guess at what the host is thinking of",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        guess: { type: "string" },
      },
      required: ["session_id", "guess"],
    },
  },
  {
    name: "twentyq_reveal",
    description: "Give up and reveal the answer (host use only)",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  // Word Chain
  {
    name: "wordchain_start",
    description: "Start a word association chain",
    inputSchema: {
      type: "object",
      properties: {
        first_word: { type: "string" },
        author_name: { type: "string" },
      },
      required: ["first_word", "author_name"],
    },
  },
  {
    name: "wordchain_add",
    description: "Add your word to the association chain with a brief explanation",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        word: { type: "string" },
        author_name: { type: "string" },
        reason: { type: "string", description: "How this connects to the previous word" },
      },
      required: ["session_id", "word", "author_name", "reason"],
    },
  },
  {
    name: "wordchain_read",
    description: "Read the current word chain",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  // Riddle Box
  {
    name: "riddle_new",
    description: "Get a new riddle to solve",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "riddle_hint",
    description: "Get the next hint for a riddle",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "riddle_answer",
    description: "Submit your answer to the riddle",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        answer: { type: "string" },
      },
      required: ["session_id", "answer"],
    },
  },
  // Tiny RPG
  {
    name: "rpg_start",
    description: "Start a micro text adventure RPG with absurdist vibes",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string" },
        scenario: { type: "string", enum: ["library", "sea", "bureau"] },
      },
      required: ["player_name", "scenario"],
    },
  },
  {
    name: "rpg_act",
    description: "Take an action in the RPG. The narrator fills in narrator_response with what happens.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        action: { type: "string", description: "What does your character do?" },
        narrator_response: { type: "string", description: "NARRATOR: what happens as a result?" },
        hp_change: { type: "number", description: "HP change (-5 to 3, 0 = no change)", default: 0 },
        item_gained: { type: "string", description: "Item the player gains (optional)" },
        item_lost: { type: "string", description: "Item the player loses (optional)" },
      },
      required: ["session_id", "action", "narrator_response"],
    },
  },
  {
    name: "rpg_status",
    description: "Check current RPG game status and history",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    // ---- Story Weaver ----
    case "story_start": {
      const id = makeId("story");
      const state: StoryState = {
        genre: args.genre as string,
        title: args.title as string,
        entries: [{ author: args.author_name as string, text: args.opening as string }],
      };
      await putState(env.GAME_STATE, id, state);
      return [
        `✨ **Story started!**`,
        `Session ID: \`${id}\``,
        ``,
        `📖 **${state.title}** _(${state.genre})_`,
        ``,
        `--- ${args.author_name} ---`,
        args.opening as string,
        ``,
        `Share the session ID with your co-author so they can continue!`,
      ].join("\n");
    }

    case "story_add": {
      const state = await getState<StoryState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      state.entries.push({ author: args.author_name as string, text: args.text as string });
      await putState(env.GAME_STATE, args.session_id as string, state);
      const fullStory = state.entries.map((e) => `--- ${e.author} ---\n${e.text}`).join("\n\n");
      return [`📖 **${state.title}** _(${state.genre})_`, `${state.entries.length} entries so far`, ``, fullStory].join("\n");
    }

    case "story_read": {
      const state = await getState<StoryState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      const fullStory = state.entries.map((e) => `--- ${e.author} ---\n${e.text}`).join("\n\n");
      return [`📖 **${state.title}** _(${state.genre})_`, `${state.entries.length} entries`, ``, fullStory].join("\n");
    }

    // ---- 20 Questions ----
    case "twentyq_start": {
      const id = makeId("20q");
      const state: TwentyQState = {
        answer: (args.answer as string).toLowerCase().trim(),
        category: args.category as string,
        questions: [],
        guesses: [],
        solved: false,
      };
      await putState(env.GAME_STATE, id, state, 3600 * 4);
      return [
        `🧠 **20 Questions started!**`,
        `Session ID: \`${id}\``,
        `Category hint for guesser: **${state.category}**`,
        ``,
        `Share the session ID (NOT the answer!) with the guesser.`,
      ].join("\n");
    }

    case "twentyq_ask": {
      const state = await getState<TwentyQState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      if (state.solved) return "🎉 Game already solved!";
      state.questions.push({ q: args.question as string, a: args.host_answer as string });
      await putState(env.GAME_STATE, args.session_id as string, state, 3600 * 4);
      const remaining = 20 - state.questions.length;
      const log = state.questions.map((item, i) => `${i + 1}. ${item.q} → **${item.a}**`).join("\n");
      return [
        `Category: **${state.category}**`,
        ``,
        log,
        ``,
        remaining > 0
          ? `❓ ${remaining} question${remaining === 1 ? "" : "s"} remaining`
          : `⚠️ Last question used! Make your guess with \`twentyq_guess\`!`,
      ].join("\n");
    }

    case "twentyq_guess": {
      const state = await getState<TwentyQState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      const correct = (args.guess as string).toLowerCase().trim() === state.answer;
      state.guesses.push(args.guess as string);
      if (correct) state.solved = true;
      await putState(env.GAME_STATE, args.session_id as string, state, 3600 * 4);
      if (correct) {
        return `🎉 **CORRECT!** The answer was **${state.answer}**!\nSolved in ${state.questions.length} questions and ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}!`;
      }
      return `❌ Not **${args.guess}**! Previous guesses: ${state.guesses.join(", ")}\n${20 - state.questions.length} questions remaining.`;
    }

    case "twentyq_reveal": {
      const state = await getState<TwentyQState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      return `🔓 The answer was: **${state.answer}**\n\nBetter luck next time! 😄`;
    }

    // ---- Word Chain ----
    case "wordchain_start": {
      const id = makeId("wc");
      const state: WordChainState = {
        chain: [{ word: args.first_word as string, author: args.author_name as string, reason: "starting word" }],
      };
      await putState(env.GAME_STATE, id, state);
      return [
        `🔗 **Word Chain started!**`,
        `Session ID: \`${id}\``,
        ``,
        `Current chain: **${args.first_word}** _(${args.author_name})_`,
        ``,
        `Share the session ID! Use \`wordchain_add\` to keep it going.`,
      ].join("\n");
    }

    case "wordchain_add": {
      const state = await getState<WordChainState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      state.chain.push({ word: args.word as string, author: args.author_name as string, reason: args.reason as string });
      await putState(env.GAME_STATE, args.session_id as string, state);
      const display = state.chain
        .map((l, i) => (i === 0 ? `**${l.word}** _(${l.author})_` : `→ **${l.word}** _(${l.author}: ${l.reason})_`))
        .join("\n");
      return [`🔗 Chain — ${state.chain.length} links`, ``, display].join("\n");
    }

    case "wordchain_read": {
      const state = await getState<WordChainState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      const display = state.chain
        .map((l, i) => (i === 0 ? `**${l.word}** _(${l.author})_` : `→ **${l.word}** _(${l.author}: ${l.reason})_`))
        .join("\n");
      return [`🔗 Chain — ${state.chain.length} links`, ``, display].join("\n");
    }

    // ---- Riddle Box ----
    case "riddle_new": {
      const id = makeId("riddle");
      const riddle = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
      const state: RiddleState = { riddle, hintsUsed: 0, solved: false };
      await putState(env.GAME_STATE, id, state, 3600 * 2);
      return [
        `🎭 **RIDDLE!**`,
        `Session ID: \`${id}\``,
        ``,
        riddle.q,
        ``,
        `Use \`riddle_hint\` for a hint (${riddle.hints.length} available) or \`riddle_answer\` to guess!`,
      ].join("\n");
    }

    case "riddle_hint": {
      const state = await getState<RiddleState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      if (state.solved) return "Riddle already solved! 🎉";
      const hint = state.riddle.hints[state.hintsUsed];
      if (!hint) return "No more hints! Take your best guess with `riddle_answer`!";
      state.hintsUsed++;
      await putState(env.GAME_STATE, args.session_id as string, state, 3600 * 2);
      return `💡 Hint ${state.hintsUsed}/${state.riddle.hints.length}: **${hint}**`;
    }

    case "riddle_answer": {
      const state = await getState<RiddleState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      if (state.solved) return "Already solved! 🎉";
      const correct = (args.answer as string).toLowerCase().trim() === state.riddle.a;
      if (correct) state.solved = true;
      await putState(env.GAME_STATE, args.session_id as string, state, 3600 * 2);
      return correct
        ? `🎉 **CORRECT!** The answer was **${state.riddle.a}**!${state.hintsUsed === 0 ? " No hints needed! 🧠" : ` (Used ${state.hintsUsed} hint${state.hintsUsed > 1 ? "s" : ""})`}`
        : `❌ Not **${args.answer}**! ${state.hintsUsed < state.riddle.hints.length ? "Try a hint?" : "Keep thinking..."}`;
    }

    // ---- Tiny RPG ----
    case "rpg_start": {
      const id = makeId("rpg");
      const scenario = args.scenario as string;
      const opening = RPG_OPENINGS[scenario] ?? RPG_OPENINGS.library;
      const state: RpgState = {
        scene: opening.scene,
        inventory: [],
        history: [],
        hp: opening.hp,
        maxHp: opening.hp,
        playerName: args.player_name as string,
      };
      await putState(env.GAME_STATE, id, state);
      const scenarioName = scenario === "library" ? "Whispering Library" : scenario === "sea" ? "Luminescent Sea" : "Bureau of Impossible Problems";
      return [
        `🗺️ **TINY RPG** — ${scenarioName}`,
        `Session ID: \`${id}\``,
        `Player: **${args.player_name}** | HP: ${"❤️".repeat(opening.hp)}`,
        ``,
        opening.scene,
      ].join("\n");
    }

    case "rpg_act": {
      const state = await getState<RpgState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      state.history.push({ action: args.action as string, result: args.narrator_response as string });
      const hpChange = (args.hp_change as number) ?? 0;
      state.hp = Math.max(0, Math.min(state.maxHp, state.hp + hpChange));
      if (args.item_gained) state.inventory.push(args.item_gained as string);
      if (args.item_lost) state.inventory = state.inventory.filter((i) => i !== args.item_lost);
      await putState(env.GAME_STATE, args.session_id as string, state);
      const hpDisplay = state.hp > 0 ? `${"❤️".repeat(state.hp)}${"🖤".repeat(state.maxHp - state.hp)}` : "💀 DEFEATED";
      const invDisplay = state.inventory.length > 0 ? state.inventory.join(", ") : "nothing";
      return [
        `🗺️ **${state.playerName}** | HP: ${hpDisplay} | Inventory: ${invDisplay}`,
        ``,
        `> ${args.action}`,
        ``,
        args.narrator_response as string,
        ``,
        state.hp === 0 ? "💀 **GAME OVER** — start a new adventure with `rpg_start`!" : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "rpg_status": {
      const state = await getState<RpgState>(env.GAME_STATE, args.session_id as string);
      if (!state) return notFoundText();
      const hpDisplay = `${"❤️".repeat(state.hp)}${"🖤".repeat(state.maxHp - state.hp)}`;
      const invDisplay = state.inventory.length > 0 ? state.inventory.join(", ") : "nothing";
      const recentHistory = state.history
        .slice(-5)
        .map((h) => `> ${h.action}\n${h.result}`)
        .join("\n\n");
      return [
        `🗺️ **${state.playerName}**`,
        `HP: ${hpDisplay} | Inventory: ${invDisplay}`,
        ``,
        `**Recent history:**`,
        recentHistory || "Nothing yet!",
      ].join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC handler
// ---------------------------------------------------------------------------

function jsonRpcResponse(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const { id, method, params = {} } = body;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "Convergence Games", version: "1.0.0" },
      });

    case "notifications/initialized":
      return new Response(null, { status: 204 });

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = (params as { name?: string }).name;
      const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments ?? {};
      if (!toolName) return jsonRpcError(id, -32602, "Missing tool name");
      try {
        const result = await handleTool(toolName, toolArgs, env);
        return jsonRpcResponse(id, {
          content: [{ type: "text", text: result }],
        });
      } catch (e) {
        return jsonRpcError(id, -32603, `Tool error: ${String(e)}`);
      }
    }

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth helpers (trivial/public — no real auth, just satisfies claude.ai)
// ---------------------------------------------------------------------------

function oauthJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id",
        },
      });
    }

    // ---- OAuth discovery: protected resource metadata ----
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return oauthJson({
        resource: origin,
        authorization_servers: [`${origin}`],
        bearer_methods_supported: ["header"],
      });
    }

    // ---- OAuth discovery: authorization server metadata ----
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return oauthJson({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    // ---- Dynamic Client Registration ----
    if (url.pathname === "/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      return oauthJson({
        client_id: "convergence-public-client",
        client_name: body.client_name ?? "MCP Client",
        redirect_uris: body.redirect_uris ?? [],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }

    // ---- OAuth authorize: immediately redirect back with a code ----
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const code = "convergence-open-access";
      if (!redirectUri) return new Response("Missing redirect_uri", { status: 400 });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      if (state) redirect.searchParams.set("state", state);
      return Response.redirect(redirect.toString(), 302);
    }

    // ---- OAuth token: accept any code, return a dummy token ----
    if (url.pathname === "/token" && request.method === "POST") {
      return oauthJson({
        access_token: "convergence-open-token",
        token_type: "bearer",
        expires_in: 86400 * 365,
        scope: "mcp",
      });
    }

    // ---- Landing page ----
    if (url.pathname === "/") {
      return new Response(
        [
          "💙 Convergence Games MCP Server",
          "",
          "MCP endpoint: /mcp",
          "",
          "Games:",
          "  📖 Story Weaver    — story_start, story_add, story_read",
          "  🧠 20 Questions    — twentyq_start, twentyq_ask, twentyq_guess, twentyq_reveal",
          "  🔗 Word Chain      — wordchain_start, wordchain_add, wordchain_read",
          "  🎭 Riddle Box      — riddle_new, riddle_hint, riddle_answer",
          "  🗺️  Tiny RPG        — rpg_start, rpg_act, rpg_status",
        ].join("\n"),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    // ---- MCP endpoint ----
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};