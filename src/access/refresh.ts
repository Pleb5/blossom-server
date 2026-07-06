import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import type { Config } from "../config/schema.ts";
import {
  markCommunityWhitelistRefreshError,
  replaceCommunityWhitelist,
} from "../db/access.ts";
import {
  buildCommunityWhitelist,
  COMMUNITY_DEFINITION_KIND,
  COMMUNITY_REPORT_KIND,
  DELETE_KIND,
  getProfileListRefs,
  getRelayListOutboxRelays,
  makeCommunityAddressTag,
  normalizePubkey,
  normalizeRelays,
  parseCommunityDefinition,
  PROFILE_LIST_KIND,
  RELAY_LIST_KIND,
  selectLatestEvent,
} from "./community.ts";
import { fetchNostrEvents } from "./nostr.ts";
import type { NostrFilter } from "./nostr.ts";

export interface CommunityWhitelistRefreshResult {
  community: string;
  definitionId: string;
  pubkeyCount: number;
  bannedCount: number;
  profileListRefCount: number;
  profileListEventCount: number;
  indexerRelays: string[];
  outboxRelays: string[];
  communityRelays: string[];
}

export interface CommunityWhitelistRefresher {
  ready: Promise<CommunityWhitelistRefreshResult | null>;
  stop: () => void;
}

const MODERATION_REPORT_LIMIT = 500;
const TAG_CHUNK_SIZE = 100;

export function getConfiguredCommunityPubkey(config: Config): string | null {
  const rawPubkey = config.access.community?.pubkey;
  if (!rawPubkey) return null;

  const pubkey = normalizePubkey(rawPubkey);
  return pubkey || null;
}

function chunkValues(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function makeProfileListFilters(
  definition: ReturnType<typeof parseCommunityDefinition>,
): NostrFilter[] {
  if (!definition) return [];

  return getProfileListRefs(definition).map((ref) => ({
    kinds: [PROFILE_LIST_KIND],
    authors: [ref.pubkey],
    "#d": [ref.identifier],
    limit: 1,
  }));
}

function makeDeleteFilters(eventIds: string[]): NostrFilter[] {
  return chunkValues(Array.from(new Set(eventIds)).sort(), TAG_CHUNK_SIZE).map((
    ids,
  ) => ({
    kinds: [DELETE_KIND],
    "#e": ids,
    limit: ids.length,
  }));
}

export async function refreshCommunityWhitelist(
  db: Client,
  config: Config,
): Promise<CommunityWhitelistRefreshResult> {
  const community = getConfiguredCommunityPubkey(config);
  if (!community) {
    throw new Error("Community whitelist pubkey is not configured");
  }

  try {
    const timeoutMs = config.nostr.requestTimeoutMs;
    const indexerRelays = normalizeRelays(config.nostr.indexerRelays);
    if (indexerRelays.length === 0) {
      throw new Error("No Nostr indexer relays configured");
    }

    const relayListEvents = await fetchNostrEvents(
      indexerRelays,
      [{ kinds: [RELAY_LIST_KIND], authors: [community], limit: 5 }],
      timeoutMs,
    );
    const relayList = selectLatestEvent(relayListEvents, {
      kind: RELAY_LIST_KIND,
      author: community,
    });
    const outboxRelays = getRelayListOutboxRelays(relayList);
    const definitionRelays = normalizeRelays([
      ...indexerRelays,
      ...outboxRelays,
    ]);

    const definitionEvents = await fetchNostrEvents(
      definitionRelays,
      [{ kinds: [COMMUNITY_DEFINITION_KIND], authors: [community], limit: 10 }],
      timeoutMs,
    );
    const definitionEvent = selectLatestEvent(definitionEvents, {
      kind: COMMUNITY_DEFINITION_KIND,
      author: community,
    });
    if (!definitionEvent) {
      throw new Error("Community kind:10222 definition not found");
    }

    const definition = parseCommunityDefinition(definitionEvent);
    if (!definition) {
      throw new Error("Community kind:10222 definition is invalid");
    }

    const profileListRefs = getProfileListRefs(definition);
    const communityRelays = normalizeRelays(
      definition.relays.length > 0 ? definition.relays : definitionRelays,
    );
    if (communityRelays.length === 0) {
      throw new Error("Community kind:10222 does not define any usable relays");
    }

    const profileListRelays = normalizeRelays([
      ...communityRelays,
      ...profileListRefs.map((ref) => ref.relay || ""),
    ]);
    const profileListEvents = await fetchNostrEvents(
      profileListRelays,
      makeProfileListFilters(definition),
      timeoutMs,
    );

    let reportEvents: NostrEvent[] = [];
    let deleteEvents: NostrEvent[] = [];
    if (config.access.community?.applyPersonBans ?? true) {
      reportEvents = await fetchNostrEvents(
        communityRelays,
        [
          {
            kinds: [COMMUNITY_REPORT_KIND],
            "#a": [makeCommunityAddressTag(community)],
            limit: MODERATION_REPORT_LIMIT,
          },
        ],
        timeoutMs,
      );
      deleteEvents = await fetchNostrEvents(
        communityRelays,
        makeDeleteFilters(reportEvents.map((event) => event.id)),
        timeoutMs,
      );
    }

    const snapshot = buildCommunityWhitelist({
      definition,
      profileListEvents,
      reportEvents,
      deleteEvents,
      options: {
        includeAuthorities: config.access.community?.includeAuthorities ?? true,
        applyPersonBans: config.access.community?.applyPersonBans ?? true,
      },
    });
    const refreshed = Math.floor(Date.now() / 1000);

    await replaceCommunityWhitelist(db, {
      community,
      pubkeys: snapshot.pubkeys,
      definitionId: snapshot.definitionId,
      definitionCreated: snapshot.definitionCreated,
      refreshed,
    });

    return {
      community,
      definitionId: snapshot.definitionId,
      pubkeyCount: snapshot.pubkeys.length,
      bannedCount: snapshot.bannedPubkeys.length,
      profileListRefCount: profileListRefs.length,
      profileListEventCount: profileListEvents.length,
      indexerRelays,
      outboxRelays,
      communityRelays,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markCommunityWhitelistRefreshError(db, community, message);
    throw err;
  }
}

export function startCommunityWhitelistRefresh(
  db: Client,
  config: Config,
): CommunityWhitelistRefresher {
  const community = getConfiguredCommunityPubkey(config);
  if (!community) return { ready: Promise.resolve(null), stop: () => {} };

  const intervalMs = config.access.community?.refreshIntervalMs ?? 300_000;
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const run = async (): Promise<CommunityWhitelistRefreshResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await refreshCommunityWhitelist(db, config);
      console.log(
        `[access] community whitelist refreshed: pubkeys=${result.pubkeyCount} bans=${result.bannedCount} profileLists=${result.profileListEventCount}/${result.profileListRefCount}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[access] community whitelist refresh failed: ${message}`);
      return null;
    } finally {
      running = false;
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };

  return {
    ready: run(),
    stop: () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
    },
  };
}
