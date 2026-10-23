/**
 * Game state storage: one Durable Object per key.
 *
 * Every game used to keep its state in Workers KV, which is eventually
 * consistent: a read can serve a cached copy up to a minute old. At our pace
 * that is one whole turn, which is where "⏳ Not your turn — Fable is up" came
 * from while rogue_status named the asker, and why a tapped chess move could
 * take a minute to reach Claude. A Durable Object lives in one place, so every
 * read sees the last write.
 *
 * The games keep the same get/put calls they made against KV, TTLs included.
 * Keys that only exist in the old KV namespace are copied over on first read,
 * with whatever expiration they had there.
 */

import { DurableObject } from "cloudflare:workers";

export interface GameKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export class GameStore extends DurableObject {
  async read(): Promise<string | null> {
    const expires = await this.ctx.storage.get<number>("expires");
    if (expires !== undefined && expires <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return null;
    }
    return (await this.ctx.storage.get<string>("value")) ?? null;
  }

  // ttl in seconds, like KV's expirationTtl; no ttl means keep forever
  async write(value: string, ttl?: number): Promise<void> {
    await this.ctx.storage.put("value", value);
    if (ttl) {
      const expires = Date.now() + ttl * 1000;
      await this.ctx.storage.put("expires", expires);
      await this.ctx.storage.setAlarm(expires);
    } else {
      await this.ctx.storage.delete("expires");
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    const expires = await this.ctx.storage.get<number>("expires");
    if (expires !== undefined && expires <= Date.now()) await this.ctx.storage.deleteAll();
  }
}

interface StoreEnv {
  GAME_STATE: KVNamespace;                      // the old home, read only for migration
  GAME_STORE: DurableObjectNamespace<GameStore>;
}

export function gameStore(env: StoreEnv): GameKV {
  const stub = (key: string) => env.GAME_STORE.get(env.GAME_STORE.idFromName(key));
  return {
    async get(key) {
      const store = stub(key);
      const value = await store.read();
      if (value !== null) return value;

      const legacy = await env.GAME_STATE.get(key);
      if (legacy === null) return null;
      const listed = await env.GAME_STATE.list({ prefix: key, limit: 1 });
      const expiration = listed.keys.find((k) => k.name === key)?.expiration; // unix seconds
      const ttl = expiration ? Math.max(60, expiration - Math.floor(Date.now() / 1000)) : undefined;
      await store.write(legacy, ttl);
      return legacy;
    },
    async put(key, value, options) {
      await stub(key).write(value, options?.expirationTtl);
    },
  };
}
