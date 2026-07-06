import type { Context } from "@hono/hono";
import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import type { Config } from "../config/schema.ts";
import {
  getCommunityWhitelistState,
  isPubkeyCommunityWhitelisted,
} from "../db/access.ts";
import { errorResponse } from "../middleware/errors.ts";
import type { BlossomVariables } from "../middleware/auth.ts";
import { normalizePubkey } from "./community.ts";
import { getConfiguredCommunityPubkey } from "./refresh.ts";

export type CommunityAccessMode = "read" | "write";

export function requiresCommunityWhitelist(
  config: Config,
  mode: CommunityAccessMode,
): boolean {
  return mode === "write"
    ? config.access.write.requireCommunityWhitelist
    : config.access.read.requireCommunityWhitelist;
}

export async function requireCommunityWhitelist(
  ctx: Context<{ Variables: BlossomVariables }>,
  db: Client,
  config: Config,
  mode: CommunityAccessMode,
  auth: NostrEvent | undefined,
): Promise<Response | null> {
  if (!requiresCommunityWhitelist(config, mode)) return null;

  const community = getConfiguredCommunityPubkey(config);
  if (!community) {
    return errorResponse(ctx, 500, "Community whitelist is misconfigured");
  }

  const pubkey = auth ? normalizePubkey(auth.pubkey) : "";
  if (!pubkey) return errorResponse(ctx, 401, "Authorization required");

  const state = await getCommunityWhitelistState(db, community);
  if (!state || state.refreshed === 0) {
    return errorResponse(ctx, 503, "Community whitelist is not initialized");
  }

  if (!(await isPubkeyCommunityWhitelisted(db, community, pubkey))) {
    return errorResponse(
      ctx,
      403,
      "Pubkey not whitelisted by community moderators",
    );
  }

  return null;
}
