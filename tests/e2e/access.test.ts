import { assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import type { Hono } from "@hono/hono";
import { initDb } from "../../src/db/client.ts";
import { replaceCommunityWhitelist } from "../../src/db/access.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { initPool } from "../../src/workers/pool.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { BlossomVariables } from "../../src/middleware/auth.ts";

const testOpts = { sanitizeOps: false, sanitizeResources: false } as const;
const communityPubkey = "a".repeat(64);
const allowedSecretKey = generateSecretKey();
const deniedSecretKey = generateSecretKey();
const allowedPubkey = getPublicKey(allowedSecretKey);

let app: Hono<{ Variables: BlossomVariables }>;
let cleanup: () => Promise<void>;

function makeAuth(secretKey: Uint8Array): NostrEvent {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["expiration", String(now + 600)],
      ],
      content: "Upload blob",
    },
    secretKey,
  );
}

function encodeAuth(event: NostrEvent): string {
  return `Nostr ${
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))
  }`;
}

Deno.test({
  name: "access e2e setup: initialize community-whitelisted server",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_access_" });
    const dbPath = join(tmpDir, "test.db");
    const db = await initDb({ path: dbPath });
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const pool = initPool(1, 4, 500, db, { path: dbPath });

    await replaceCommunityWhitelist(db, {
      community: communityPubkey,
      pubkeys: [allowedPubkey],
      definitionId: "d".repeat(64),
      definitionCreated: 1,
      refreshed: Math.floor(Date.now() / 1000),
    });

    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      upload: { requireAuth: false, enabled: true },
      access: {
        community: { pubkey: communityPubkey },
        write: { requireCommunityWhitelist: true },
      },
    });

    app = await buildApp(db, storage, config);
    cleanup = async () => {
      pool.shutdown();
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    };
  },
  ...testOpts,
});

Deno.test({
  name: "HEAD /upload allows whitelisted community pubkey",
  async fn() {
    const res = await app.fetch(
      new Request("http://localhost/upload", {
        method: "HEAD",
        headers: {
          "X-Content-Length": "10",
          "X-Content-Type": "application/octet-stream",
          Authorization: encodeAuth(makeAuth(allowedSecretKey)),
        },
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "HEAD /upload rejects non-whitelisted community pubkey",
  async fn() {
    const res = await app.fetch(
      new Request("http://localhost/upload", {
        method: "HEAD",
        headers: {
          "X-Content-Length": "10",
          "X-Content-Type": "application/octet-stream",
          Authorization: encodeAuth(makeAuth(deniedSecretKey)),
        },
      }),
    );
    assertEquals(res.status, 403);
    assertEquals(
      res.headers.get("X-Reason"),
      "Pubkey not whitelisted by community moderators",
    );
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "HEAD /upload requires auth when community write whitelist is enabled",
  async fn() {
    const res = await app.fetch(
      new Request("http://localhost/upload", {
        method: "HEAD",
        headers: {
          "X-Content-Length": "10",
          "X-Content-Type": "application/octet-stream",
        },
      }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "access e2e teardown: cleanup",
  async fn() {
    await cleanup();
  },
  ...testOpts,
});
