import type { Client } from "@libsql/client";

export interface CommunityWhitelistState {
  community: string;
  definitionId: string | null;
  definitionCreated: number | null;
  refreshed: number;
  pubkeyCount: number;
  lastError: string | null;
}

export interface ReplaceCommunityWhitelistOptions {
  community: string;
  pubkeys: string[];
  definitionId: string;
  definitionCreated: number;
  refreshed: number;
}

export async function replaceCommunityWhitelist(
  db: Client,
  opts: ReplaceCommunityWhitelistOptions,
): Promise<void> {
  const uniquePubkeys = Array.from(new Set(opts.pubkeys));
  await db.batch(
    [
      {
        sql: "DELETE FROM community_whitelist WHERE community = ?",
        args: [opts.community],
      },
      ...uniquePubkeys.map((pubkey) => ({
        sql:
          "INSERT INTO community_whitelist (community, pubkey, refreshed) VALUES (?, ?, ?)",
        args: [opts.community, pubkey, opts.refreshed],
      })),
      {
        sql: `INSERT OR REPLACE INTO community_whitelist_state
              (community, definition_id, definition_created, refreshed, pubkey_count, last_error)
              VALUES (?, ?, ?, ?, ?, NULL)`,
        args: [
          opts.community,
          opts.definitionId,
          opts.definitionCreated,
          opts.refreshed,
          uniquePubkeys.length,
        ],
      },
    ],
    "write",
  );
}

export async function markCommunityWhitelistRefreshError(
  db: Client,
  community: string,
  error: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO community_whitelist_state
          (community, refreshed, pubkey_count, last_error)
          VALUES (?, 0, 0, ?)
          ON CONFLICT(community) DO UPDATE SET last_error = excluded.last_error`,
    args: [community, error],
  });
}

export async function getCommunityWhitelistState(
  db: Client,
  community: string,
): Promise<CommunityWhitelistState | null> {
  const rs = await db.execute({
    sql:
      `SELECT community, definition_id, definition_created, refreshed, pubkey_count, last_error
          FROM community_whitelist_state
          WHERE community = ?`,
    args: [community],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    community: row[0] as string,
    definitionId: row[1] as string | null,
    definitionCreated: row[2] as number | null,
    refreshed: row[3] as number,
    pubkeyCount: row[4] as number,
    lastError: row[5] as string | null,
  };
}

export async function isPubkeyCommunityWhitelisted(
  db: Client,
  community: string,
  pubkey: string,
): Promise<boolean> {
  const rs = await db.execute({
    sql:
      "SELECT 1 FROM community_whitelist WHERE community = ? AND pubkey = ? LIMIT 1",
    args: [community, pubkey],
  });
  return rs.rows.length > 0;
}
