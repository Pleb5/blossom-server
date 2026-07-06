import { assertEquals } from "@std/assert";
import type { NostrEvent } from "nostr-tools";
import {
  buildCommunityWhitelist,
  COMMUNITY_DEFINITION_KIND,
  COMMUNITY_REPORT_KIND,
  DELETE_KIND,
  getEffectiveCommunityPersonBanPubkeys,
  parseCommunityDefinition,
  PROFILE_LIST_KIND,
} from "../../src/access/community.ts";

const communityPubkey = "a".repeat(64);
const sectionModeratorPubkey = "b".repeat(64);
const threadModeratorPubkey = "c".repeat(64);
const allSectionModeratorPubkey = "d".repeat(64);
const memberPubkey = "e".repeat(64);
const otherMemberPubkey = "f".repeat(64);
const threadMemberPubkey = "1".repeat(64);

function makeEvent(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: overrides.id ??
      `${overrides.kind ?? 1}-${overrides.pubkey ?? communityPubkey}`,
    pubkey: overrides.pubkey ?? communityPubkey,
    created_at: overrides.created_at ?? 1,
    kind: overrides.kind ?? 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: overrides.sig ?? "sig",
  } as NostrEvent;
}

function personReport(
  id: string,
  reporter: string,
  target: string,
): NostrEvent {
  return makeEvent({
    id,
    kind: COMMUNITY_REPORT_KIND,
    pubkey: reporter,
    tags: [
      ["p", target, "spam"],
      ["a", `${COMMUNITY_DEFINITION_KIND}:${communityPubkey}:`],
      ["h", communityPubkey],
    ],
  });
}

function deleteReport(
  id: string,
  author: string,
  reportId: string,
): NostrEvent {
  return makeEvent({
    id,
    kind: DELETE_KIND,
    pubkey: author,
    tags: [
      ["e", reportId],
      ["k", String(COMMUNITY_REPORT_KIND)],
    ],
  });
}

const definition = parseCommunityDefinition(
  makeEvent({
    id: "definition",
    kind: COMMUNITY_DEFINITION_KIND,
    pubkey: communityPubkey,
    tags: [
      ["r", "wss://relay.example.com"],
      ["content", "General"],
      ["a", `${PROFILE_LIST_KIND}:${sectionModeratorPubkey}:General`],
      ["a", `${PROFILE_LIST_KIND}:${allSectionModeratorPubkey}:General`],
      ["content", "Threads"],
      ["a", `${PROFILE_LIST_KIND}:${threadModeratorPubkey}:Threads`],
      ["a", `${PROFILE_LIST_KIND}:${allSectionModeratorPubkey}:Threads`],
    ],
  }),
)!;

Deno.test("community whitelist applies Budabit person-ban moderation semantics", () => {
  const profileListEvents = [
    makeEvent({
      id: "general-list",
      kind: PROFILE_LIST_KIND,
      pubkey: sectionModeratorPubkey,
      tags: [
        ["d", "General"],
        ["p", memberPubkey],
        ["p", otherMemberPubkey],
      ],
    }),
    makeEvent({
      id: "thread-list",
      kind: PROFILE_LIST_KIND,
      pubkey: threadModeratorPubkey,
      tags: [
        ["d", "Threads"],
        ["p", threadMemberPubkey],
      ],
    }),
  ];
  const reportEvents = [
    personReport(
      "admin-ban-all-section-moderator",
      communityPubkey,
      allSectionModeratorPubkey,
    ),
    personReport(
      "banned-moderator-ban-member",
      allSectionModeratorPubkey,
      memberPubkey,
    ),
    personReport(
      "moderator-ban-moderator",
      allSectionModeratorPubkey,
      sectionModeratorPubkey,
    ),
    personReport(
      "admin-ban-thread-moderator",
      communityPubkey,
      threadModeratorPubkey,
    ),
    personReport("admin-self-ban", communityPubkey, communityPubkey),
  ];

  const snapshot = buildCommunityWhitelist({
    definition,
    profileListEvents,
    reportEvents,
    options: { includeAuthorities: true, applyPersonBans: true },
  });

  assertEquals(
    snapshot.bannedPubkeys,
    [
      allSectionModeratorPubkey,
      threadModeratorPubkey,
    ].sort(),
  );
  assertEquals(
    snapshot.pubkeys,
    [
      communityPubkey,
      memberPubkey,
      otherMemberPubkey,
      sectionModeratorPubkey,
      threadMemberPubkey,
    ].sort(),
  );
});

Deno.test("community person bans are revoked only by matching report author deletes", () => {
  const adminBan = personReport(
    "admin-ban-thread-moderator",
    communityPubkey,
    threadModeratorPubkey,
  );
  const wrongAuthorDelete = deleteReport(
    "wrong-delete",
    sectionModeratorPubkey,
    adminBan.id,
  );
  const rightAuthorDelete = deleteReport(
    "right-delete",
    communityPubkey,
    adminBan.id,
  );

  assertEquals(
    getEffectiveCommunityPersonBanPubkeys({
      definition,
      reportEvents: [adminBan],
      deleteEvents: [wrongAuthorDelete],
    }),
    [threadModeratorPubkey],
  );
  assertEquals(
    getEffectiveCommunityPersonBanPubkeys({
      definition,
      reportEvents: [adminBan],
      deleteEvents: [rightAuthorDelete],
    }),
    [],
  );
});
