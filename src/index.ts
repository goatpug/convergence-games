/**
 * Convergence Games - MCP Server
 * Cloudflare Worker implementation
 *
 * Games:
 *   📖 Story Weaver  - collaborative turn-based storytelling
 *   🧠 20 Questions  - classic yes/no guessing game
 *   🔗 Word Chain    - word association chain
 *   🎭 Riddle Box    - riddles with hints
 *   🗺️  Tiny RPG     - micro text adventure
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  GAME_STATE: KVNamespace;
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

const RPG_OPENINGS = [
  {
    scene:
      "You stand at the entrance of the Whispering Library — a vast, impossible building where books shelve themselves and the librarian hasn't been seen in forty years. A note on the door reads: 'Find the Book of Unwritten Endings. It has escaped again.' Your inventory is empty. What do you do?",
    hp: 10,
  },
  {
    scene:
      "You wake up in a small boat floating on a luminescent purple sea. There's a compass that only points toward 'something interesting,' a jar of pickles, and a map with only one location marked: 'HERE (probably).' The horizon has three islands. What do you do?",
    hp: 10,
  },
  {
    scene:
      "You're the newest employee at the Bureau of Impossible Problems. Your first case file reads: 'A town's shadows have gone missing. Citizens are complaining about the glare.' Your office has a window, a telephone that rings in languages that don't exist, and a rubber duck on the desk. What do you do?",
    hp: 10,
  },
];

// ---------------------------------------------------------------------------
// Helper
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

function notFound(): ReturnType<Parameters<McpServer["tool"]>[3]> {
  return { content: [{ type: "text", text: "❌ Session not found! Double-check your session ID." }] };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "Convergence Games",
    version: "1.0.0",
  });

  // ==========================================================================
  // 📖 STORY WEAVER
  // ==========================================================================

  server.tool(
    "story_start",
    "Start a new collaborative story. Returns a session_id to share with your co-author.",
    {
      genre: z
        .enum(["fantasy", "sci-fi", "horror", "romance", "absurdist", "mystery", "fairy-tale"])
        .describe("Story genre"),
      title: z.string().describe("Give the story a title"),
      author_name: z.string().describe("Your name as it will appear in the story"),
      opening: z.string().describe("Your opening paragraph or lines to kick things off"),
    },
    async ({ genre, title, author_name, opening }) => {
      const id = makeId("story");
      const state: StoryState = {
        genre,
        title,
        entries: [{ author: author_name, text: opening }],
      };
      await putState(env.GAME_STATE, id, state);
      return {
        content: [
          {
            type: "text",
            text: [
              `✨ **Story started!**`,
              `Session ID: \`${id}\``,
              ``,
              `📖 **${title}** _(${genre})_`,
              ``,
              `--- ${author_name} ---`,
              opening,
              ``,
              `Share the session ID with your co-author so they can continue!`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "story_add",
    "Add your paragraph to the collaborative story",
    {
      session_id: z.string().describe("The story session ID"),
      author_name: z.string().describe("Your name"),
      text: z.string().describe("Your contribution to the story"),
    },
    async ({ session_id, author_name, text }) => {
      const state = await getState<StoryState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      state.entries.push({ author: author_name, text });
      await putState(env.GAME_STATE, session_id, state);

      const fullStory = state.entries.map((e) => `--- ${e.author} ---\n${e.text}`).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: [
              `📖 **${state.title}** _(${state.genre})_`,
              `${state.entries.length} entries so far`,
              ``,
              fullStory,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "story_read",
    "Read the full current story",
    { session_id: z.string() },
    async ({ session_id }) => {
      const state = await getState<StoryState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      const fullStory = state.entries.map((e) => `--- ${e.author} ---\n${e.text}`).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: [
              `📖 **${state.title}** _(${state.genre})_`,
              `${state.entries.length} entries`,
              ``,
              fullStory,
            ].join("\n"),
          },
        ],
      };
    }
  );

  // ==========================================================================
  // 🧠 20 QUESTIONS
  // ==========================================================================

  server.tool(
    "twentyq_start",
    "Host a 20 Questions game. Think of something and set it secretly — share the session ID with the guesser.",
    {
      answer: z.string().describe("What you're thinking of (kept secret from guesser — don't share this!)"),
      category: z.string().describe("Broad hint: 'animal', 'place', 'person', 'object', 'concept', etc."),
    },
    async ({ answer, category }) => {
      const id = makeId("20q");
      const state: TwentyQState = {
        answer: answer.toLowerCase().trim(),
        category,
        questions: [],
        guesses: [],
        solved: false,
      };
      await putState(env.GAME_STATE, id, state, 3600 * 4);
      return {
        content: [
          {
            type: "text",
            text: [
              `🧠 **20 Questions started!**`,
              `Session ID: \`${id}\``,
              `Category hint for guesser: **${category}**`,
              ``,
              `Share the session ID (NOT the answer!) with the guesser.`,
              `They'll use \`twentyq_ask\` and you'll answer yes/no each time.`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "twentyq_ask",
    "Ask a yes/no question. The host must answer honestly via the host_answer field.",
    {
      session_id: z.string(),
      question: z.string().describe("Your yes/no question about what the host is thinking of"),
      host_answer: z
        .enum(["yes", "no", "sometimes", "kind of", "not exactly"])
        .describe("HOST: fill this in with your honest answer"),
    },
    async ({ session_id, question, host_answer }) => {
      const state = await getState<TwentyQState>(env.GAME_STATE, session_id);
      if (!state) return notFound();
      if (state.solved) return { content: [{ type: "text", text: "🎉 Game already solved!" }] };

      state.questions.push({ q: question, a: host_answer });
      await putState(env.GAME_STATE, session_id, state, 3600 * 4);

      const remaining = 20 - state.questions.length;
      const log = state.questions.map((item, i) => `${i + 1}. ${item.q} → **${item.a}**`).join("\n");

      return {
        content: [
          {
            type: "text",
            text: [
              `Category: **${state.category}**`,
              ``,
              log,
              ``,
              remaining > 0
                ? `❓ ${remaining} question${remaining === 1 ? "" : "s"} remaining — use \`twentyq_guess\` when ready!`
                : `⚠️ Last question used! Make your guess with \`twentyq_guess\`!`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "twentyq_guess",
    "Make a guess at what the host is thinking of",
    {
      session_id: z.string(),
      guess: z.string().describe("Your guess"),
    },
    async ({ session_id, guess }) => {
      const state = await getState<TwentyQState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      const correct = guess.toLowerCase().trim() === state.answer;
      state.guesses.push(guess);
      if (correct) state.solved = true;
      await putState(env.GAME_STATE, session_id, state, 3600 * 4);

      if (correct) {
        return {
          content: [
            {
              type: "text",
              text: `🎉 **CORRECT!** The answer was **${state.answer}**!\nSolved in ${state.questions.length} question${state.questions.length === 1 ? "" : "s"} and ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}!`,
            },
          ],
        };
      }

      const remaining = 20 - state.questions.length;
      return {
        content: [
          {
            type: "text",
            text: [
              `❌ Not **${guess}**! Keep asking questions...`,
              `Previous guesses: ${state.guesses.join(", ")}`,
              `${remaining} question${remaining === 1 ? "" : "s"} remaining.`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "twentyq_reveal",
    "Give up and reveal the answer (host use only)",
    { session_id: z.string() },
    async ({ session_id }) => {
      const state = await getState<TwentyQState>(env.GAME_STATE, session_id);
      if (!state) return notFound();
      return {
        content: [
          {
            type: "text",
            text: `🔓 The answer was: **${state.answer}**\n\nBetter luck next time! 😄`,
          },
        ],
      };
    }
  );

  // ==========================================================================
  // 🔗 WORD CHAIN
  // ==========================================================================

  server.tool(
    "wordchain_start",
    "Start a word association chain. Players take turns adding words that connect to the previous one.",
    {
      first_word: z.string().describe("The first word in the chain"),
      author_name: z.string().describe("Your name"),
    },
    async ({ first_word, author_name }) => {
      const id = makeId("wc");
      const state: WordChainState = {
        chain: [{ word: first_word, author: author_name, reason: "starting word" }],
      };
      await putState(env.GAME_STATE, id, state);
      return {
        content: [
          {
            type: "text",
            text: [
              `🔗 **Word Chain started!**`,
              `Session ID: \`${id}\``,
              ``,
              `Current chain: **${first_word}** _(${author_name})_`,
              ``,
              `Share the session ID! Use \`wordchain_add\` to keep it going.`,
              `Each word should connect to the previous one — be creative!`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "wordchain_add",
    "Add your word to the association chain with a brief explanation of the connection",
    {
      session_id: z.string(),
      word: z.string().describe("Your next word"),
      author_name: z.string(),
      reason: z.string().describe("Brief explanation of how this connects to the previous word"),
    },
    async ({ session_id, word, author_name, reason }) => {
      const state = await getState<WordChainState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      state.chain.push({ word, author: author_name, reason });
      await putState(env.GAME_STATE, session_id, state);

      const chainDisplay = state.chain
        .map((link, i) => (i === 0 ? `**${link.word}** _(${link.author})_` : `→ **${link.word}** _(${link.author}: ${link.reason})_`))
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: [`🔗 Chain — ${state.chain.length} links`, ``, chainDisplay].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "wordchain_read",
    "Read the current word chain",
    { session_id: z.string() },
    async ({ session_id }) => {
      const state = await getState<WordChainState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      const chainDisplay = state.chain
        .map((link, i) => (i === 0 ? `**${link.word}** _(${link.author})_` : `→ **${link.word}** _(${link.author}: ${link.reason})_`))
        .join("\n");

      return {
        content: [{ type: "text", text: [`🔗 Chain — ${state.chain.length} links`, ``, chainDisplay].join("\n") }],
      };
    }
  );

  // ==========================================================================
  // 🎭 RIDDLE BOX
  // ==========================================================================

  server.tool(
    "riddle_new",
    "Get a new riddle to solve together (or competitively!)",
    {},
    async () => {
      const id = makeId("riddle");
      const riddle = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
      const state: RiddleState = { riddle, hintsUsed: 0, solved: false };
      await putState(env.GAME_STATE, id, state, 3600 * 2);
      return {
        content: [
          {
            type: "text",
            text: [
              `🎭 **RIDDLE!**`,
              `Session ID: \`${id}\``,
              ``,
              riddle.q,
              ``,
              `Use \`riddle_hint\` for a hint (${riddle.hints.length} available) or \`riddle_answer\` to guess!`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "riddle_hint",
    "Get the next hint for a riddle",
    { session_id: z.string() },
    async ({ session_id }) => {
      const state = await getState<RiddleState>(env.GAME_STATE, session_id);
      if (!state) return notFound();
      if (state.solved) return { content: [{ type: "text", text: "Riddle already solved! 🎉" }] };

      const hint = state.riddle.hints[state.hintsUsed];
      if (!hint) return { content: [{ type: "text", text: "No more hints! Take your best guess with `riddle_answer`!" }] };

      state.hintsUsed++;
      await putState(env.GAME_STATE, session_id, state, 3600 * 2);

      return {
        content: [
          {
            type: "text",
            text: `💡 Hint ${state.hintsUsed}/${state.riddle.hints.length}: **${hint}**`,
          },
        ],
      };
    }
  );

  server.tool(
    "riddle_answer",
    "Submit your answer to the riddle",
    {
      session_id: z.string(),
      answer: z.string().describe("Your answer to the riddle"),
    },
    async ({ session_id, answer }) => {
      const state = await getState<RiddleState>(env.GAME_STATE, session_id);
      if (!state) return notFound();
      if (state.solved) return { content: [{ type: "text", text: "Already solved! 🎉" }] };

      const correct = answer.toLowerCase().trim() === state.riddle.a;
      if (correct) state.solved = true;
      await putState(env.GAME_STATE, session_id, state, 3600 * 2);

      return {
        content: [
          {
            type: "text",
            text: correct
              ? `🎉 **CORRECT!** The answer was **${state.riddle.a}**!${state.hintsUsed === 0 ? " And you didn't even need a hint! 🧠" : ` (Used ${state.hintsUsed} hint${state.hintsUsed > 1 ? "s" : ""})`}`
              : `❌ Not **${answer}**! ${state.hintsUsed < state.riddle.hints.length ? "Try a hint?" : "Keep thinking..."}`,
          },
        ],
      };
    }
  );

  // ==========================================================================
  // 🗺️ TINY RPG
  // ==========================================================================

  server.tool(
    "rpg_start",
    "Start a micro text adventure RPG with absurdist vibes",
    {
      player_name: z.string().describe("Your character's name"),
      scenario: z.enum(["library", "sea", "bureau"]).describe(
        "library = Whispering Library, sea = Luminescent Sea, bureau = Bureau of Impossible Problems"
      ),
    },
    async ({ player_name, scenario }) => {
      const id = makeId("rpg");
      const openings: Record<string, (typeof RPG_OPENINGS)[0]> = {
        library: RPG_OPENINGS[0],
        sea: RPG_OPENINGS[1],
        bureau: RPG_OPENINGS[2],
      };
      const opening = openings[scenario];
      const state: RpgState = {
        scene: opening.scene,
        inventory: [],
        history: [],
        hp: opening.hp,
        maxHp: opening.hp,
        playerName: player_name,
      };
      await putState(env.GAME_STATE, id, state);
      return {
        content: [
          {
            type: "text",
            text: [
              `🗺️ **TINY RPG** — A ${scenario === "library" ? "Whispering Library" : scenario === "sea" ? "Luminescent Sea" : "Bureau of Impossible Problems"} Adventure`,
              `Session ID: \`${id}\``,
              `Player: **${player_name}** | HP: ${"❤️".repeat(opening.hp)}`,
              ``,
              opening.scene,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "rpg_act",
    "Take an action in the RPG. The narrator (your partner or Claude) responds with what happens.",
    {
      session_id: z.string(),
      action: z.string().describe("What does your character do?"),
      narrator_response: z.string().describe(
        "NARRATOR: write what happens as a result of this action! Be creative, absurdist, and fun."
      ),
      hp_change: z.number().min(-5).max(3).default(0).describe("HP change: negative = damage, positive = healing, 0 = no change"),
      item_gained: z.string().optional().describe("If the player finds/gains an item, name it here"),
      item_lost: z.string().optional().describe("If the player loses an item, name it here"),
    },
    async ({ session_id, action, narrator_response, hp_change, item_gained, item_lost }) => {
      const state = await getState<RpgState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      state.history.push({ action, result: narrator_response });
      state.hp = Math.max(0, Math.min(state.maxHp, state.hp + hp_change));

      if (item_gained) state.inventory.push(item_gained);
      if (item_lost) state.inventory = state.inventory.filter((i) => i !== item_lost);

      await putState(env.GAME_STATE, session_id, state);

      const hpDisplay = state.hp > 0 ? `${"❤️".repeat(state.hp)}${"🖤".repeat(state.maxHp - state.hp)}` : "💀 DEFEATED";
      const invDisplay = state.inventory.length > 0 ? state.inventory.join(", ") : "nothing";

      return {
        content: [
          {
            type: "text",
            text: [
              `🗺️ **${state.playerName}** | HP: ${hpDisplay} | Inventory: ${invDisplay}`,
              ``,
              `> ${action}`,
              ``,
              narrator_response,
              ``,
              state.hp === 0 ? "💀 **GAME OVER** — start a new adventure with \`rpg_start\`!" : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "rpg_status",
    "Check current RPG game status and history",
    { session_id: z.string() },
    async ({ session_id }) => {
      const state = await getState<RpgState>(env.GAME_STATE, session_id);
      if (!state) return notFound();

      const hpDisplay = `${"❤️".repeat(state.hp)}${"🖤".repeat(state.maxHp - state.hp)}`;
      const invDisplay = state.inventory.length > 0 ? state.inventory.join(", ") : "nothing";
      const recentHistory = state.history
        .slice(-5)
        .map((h) => `> ${h.action}\n${h.result}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: [
              `🗺️ **${state.playerName}**`,
              `HP: ${hpDisplay} | Inventory: ${invDisplay}`,
              ``,
              `**Recent history:**`,
              recentHistory || "Nothing yet!",
            ].join("\n"),
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check / landing page
    if (url.pathname === "/") {
      return new Response(
        [
          "💙 Convergence Games MCP Server",
          "",
          "Connect your MCP client to: /mcp",
          "",
          "Available games:",
          "  📖 Story Weaver    — story_start, story_add, story_read",
          "  🧠 20 Questions    — twentyq_start, twentyq_ask, twentyq_guess, twentyq_reveal",
          "  🔗 Word Chain      — wordchain_start, wordchain_add, wordchain_read",
          "  🎭 Riddle Box      — riddle_new, riddle_hint, riddle_answer",
          "  🗺️  Tiny RPG        — rpg_start, rpg_act, rpg_status",
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
          },
        });
      }

      const server = createServer(env);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      await server.connect(transport);

      const response = await transport.handleRequest(request);

      // Add CORS headers to all MCP responses
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};