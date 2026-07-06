import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";

export const COMMUNITY_DEFINITION_KIND = 10222;
export const PROFILE_LIST_KIND = 30000;
export const RELAY_LIST_KIND = 10002;
export const COMMUNITY_REPORT_KIND = 1984;
export const DELETE_KIND = 5;
export const COMMUNITY_REPORT_REASON = "spam";

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export interface AddressRef {
  kind: number;
  pubkey: string;
  identifier: string;
  address: string;
}

export interface CommunityProfileListRef extends AddressRef {
  relay?: string;
}

export interface CommunitySection {
  name: string;
  profileLists: CommunityProfileListRef[];
}

export interface CommunityDefinition {
  event: NostrEvent;
  pubkey: string;
  relays: string[];
  sections: CommunitySection[];
}

export interface CommunityWhitelistBuildOptions {
  includeAuthorities: boolean;
  applyPersonBans: boolean;
}

export interface CommunityWhitelistSnapshot {
  community: string;
  definitionId: string;
  definitionCreated: number;
  pubkeys: string[];
  bannedPubkeys: string[];
  profileListRefs: CommunityProfileListRef[];
}

interface ParsedCommunityPersonReport {
  event: NostrEvent;
  targetPubkey: string;
  reporterPubkey: string;
  adminAuthored: boolean;
}

export function normalizePubkey(value: string): string {
  const trimmed = value.trim();
  if (HEX_PUBKEY_RE.test(trimmed)) return trimmed.toLowerCase();

  if (trimmed.startsWith("npub")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return "";
    }
  }

  return "";
}

export function normalizeRelay(url: string | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function normalizeRelays(relays: string[]): string[] {
  return Array.from(new Set(relays.map(normalizeRelay).filter(Boolean)));
}

export function parseAddressRef(address: string): AddressRef | undefined {
  const [kindValue, pubkeyValue, ...identifierParts] = address.split(":");
  const kind = Number.parseInt(kindValue || "", 10);
  const pubkey = normalizePubkey(pubkeyValue || "");
  const identifier = identifierParts.join(":");

  if (!Number.isInteger(kind) || !pubkey || !identifier) return undefined;
  return {
    kind,
    pubkey,
    identifier,
    address: `${kind}:${pubkey}:${identifier}`,
  };
}

function parseProfileListRef(
  tag: string[],
): CommunityProfileListRef | undefined {
  const ref = parseAddressRef(tag[1] || "");
  if (!ref || ref.kind !== PROFILE_LIST_KIND) return undefined;
  return { ...ref, relay: normalizeRelay(tag[2]) || undefined };
}

function makeSection(name: string): CommunitySection {
  return { name: name.trim(), profileLists: [] };
}

export function parseCommunityDefinition(
  event: NostrEvent,
): CommunityDefinition | undefined {
  if (event.kind !== COMMUNITY_DEFINITION_KIND) return undefined;

  const pubkey = normalizePubkey(event.pubkey || "");
  if (!pubkey) return undefined;

  const relays: string[] = [];
  const sections: CommunitySection[] = [];
  let currentSection: CommunitySection | undefined;

  for (const tag of event.tags || []) {
    if (tag[0] === "content" && tag[1]) {
      currentSection = makeSection(tag[1]);
      sections.push(currentSection);
      continue;
    }

    if (tag[0] === "a" && currentSection) {
      const profileList = parseProfileListRef(tag);
      if (profileList) currentSection.profileLists.push(profileList);
      continue;
    }

    if (tag[0] === "r") {
      const relay = normalizeRelay(tag[1]);
      if (relay) relays.push(relay);
    }
  }

  return {
    event,
    pubkey,
    relays: normalizeRelays(relays),
    sections,
  };
}

export function getRelayListOutboxRelays(
  event: NostrEvent | undefined,
): string[] {
  if (!event || event.kind !== RELAY_LIST_KIND) return [];

  const allRelays = (event.tags || [])
    .filter((tag) => tag[0] === "r")
    .map((tag) => normalizeRelay(tag[1]))
    .filter(Boolean);
  const writeRelays = (event.tags || [])
    .filter((tag) => tag[0] === "r" && (!tag[2] || tag[2] === "write"))
    .map((tag) => normalizeRelay(tag[1]))
    .filter(Boolean);

  return normalizeRelays(writeRelays.length > 0 ? writeRelays : allRelays);
}

function getAddress(event: NostrEvent): string {
  const identifier = event.tags.find((tag) => tag[0] === "d")?.[1] || "";
  const pubkey = normalizePubkey(event.pubkey || "");
  return identifier && pubkey ? `${event.kind}:${pubkey}:${identifier}` : "";
}

function isPreferredEvent(
  candidate: NostrEvent,
  current: NostrEvent | undefined,
): boolean {
  if (!current) return true;
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  return candidate.id < current.id;
}

export function selectLatestEvent(
  events: NostrEvent[],
  opts: { kind?: number; author?: string } = {},
): NostrEvent | undefined {
  const author = opts.author ? normalizePubkey(opts.author) : "";
  let selected: NostrEvent | undefined;

  for (const event of events) {
    if (opts.kind !== undefined && event.kind !== opts.kind) continue;
    if (author && normalizePubkey(event.pubkey || "") !== author) continue;
    if (isPreferredEvent(event, selected)) selected = event;
  }

  return selected;
}

export function findAddressableEvent(
  ref: AddressRef | undefined,
  events: NostrEvent[],
): NostrEvent | undefined {
  if (!ref) return undefined;

  let selected: NostrEvent | undefined;
  for (const event of events) {
    if (event.kind !== ref.kind) continue;
    if (getAddress(event) !== ref.address) continue;
    if (isPreferredEvent(event, selected)) selected = event;
  }

  return selected;
}

export function getProfileListPubkeys(event: NostrEvent | undefined): string[] {
  if (!event || event.kind !== PROFILE_LIST_KIND) return [];

  return Array.from(
    new Set(
      (event.tags || [])
        .filter((tag) => tag[0] === "p")
        .map((tag) => normalizePubkey(tag[1] || ""))
        .filter(Boolean),
    ),
  );
}

export function getProfileListRefs(
  definition: CommunityDefinition,
): CommunityProfileListRef[] {
  return definition.sections.flatMap((section) => section.profileLists);
}

export function getCurrentModeratorPubkeys(
  definition: CommunityDefinition,
): string[] {
  return Array.from(
    new Set(
      getProfileListRefs(definition)
        .map((ref) => normalizePubkey(ref.pubkey))
        .filter(Boolean),
    ),
  );
}

export function getAllSectionModeratorPubkeys(
  definition: CommunityDefinition,
): string[] {
  if (definition.sections.length === 0) return [];

  const moderatorSets = definition.sections.map(
    (section) =>
      new Set(
        section.profileLists
          .map((ref) => normalizePubkey(ref.pubkey))
          .filter(Boolean),
      ),
  );
  const [firstSet, ...restSets] = moderatorSets;
  return Array.from(firstSet || []).filter((pubkey) =>
    restSets.every((set) => set.has(pubkey))
  );
}

function makeCommunityDefinitionAddress(communityPubkey: string): string {
  const pubkey = normalizePubkey(communityPubkey);
  return pubkey ? `${COMMUNITY_DEFINITION_KIND}:${pubkey}:` : "";
}

function parseCommunityDefinitionAddress(
  address: string,
): { pubkey: string; address: string } | undefined {
  const [kindValue, pubkeyValue, ...identifierParts] = address.split(":");
  const kind = Number.parseInt(kindValue || "", 10);
  const pubkey = normalizePubkey(pubkeyValue || "");
  const identifier = identifierParts.join(":");

  if (kind !== COMMUNITY_DEFINITION_KIND || !pubkey || identifier) {
    return undefined;
  }
  return { pubkey, address: `${COMMUNITY_DEFINITION_KIND}:${pubkey}:` };
}

function getCommunityAddress(
  event: NostrEvent,
): { pubkey: string; address: string } | undefined {
  return event.tags
    .filter((tag) => tag[0] === "a")
    .map((tag) => parseCommunityDefinitionAddress(tag[1] || ""))
    .find(Boolean);
}

function getReasonTag(event: NostrEvent, tagName: "p"): string[] | undefined {
  return event.tags.find(
    (tag) =>
      tag[0] === tagName &&
      (tag[2] === COMMUNITY_REPORT_REASON ||
        tag[3] === COMMUNITY_REPORT_REASON),
  );
}

function parseCommunityPersonReport(
  event: NostrEvent,
  definition: CommunityDefinition,
): ParsedCommunityPersonReport | undefined {
  if (event.kind !== COMMUNITY_REPORT_KIND) return undefined;

  const community = getCommunityAddress(event);
  if (!community || community.pubkey !== definition.pubkey) return undefined;

  const personReportTag = getReasonTag(event, "p");
  const targetPubkey = normalizePubkey(personReportTag?.[1] || "");
  const reporterPubkey = normalizePubkey(event.pubkey || "");
  if (!targetPubkey || !reporterPubkey) return undefined;

  return {
    event,
    targetPubkey,
    reporterPubkey,
    adminAuthored: reporterPubkey === definition.pubkey,
  };
}

function isCommunityReportDeleted(
  report: NostrEvent,
  deleteEvents: NostrEvent[],
): boolean {
  return deleteEvents.some((event) => {
    if (event.kind !== DELETE_KIND) return false;
    if (
      normalizePubkey(event.pubkey || "") !==
        normalizePubkey(report.pubkey || "")
    ) return false;
    if (!event.tags.some((tag) => tag[0] === "e" && tag[1] === report.id)) {
      return false;
    }

    const kindTags = event.tags.filter((tag) => tag[0] === "k");
    return kindTags.length === 0 ||
      kindTags.some((tag) => tag[1] === String(COMMUNITY_REPORT_KIND));
  });
}

function isPersonBannedByReports(
  reports: ParsedCommunityPersonReport[],
  pubkey: string,
): boolean {
  const normalizedPubkey = normalizePubkey(pubkey);
  return Boolean(
    normalizedPubkey &&
      reports.some((report) => report.targetPubkey === normalizedPubkey),
  );
}

function isProtectedModeratorTarget(
  definition: CommunityDefinition,
  report: ParsedCommunityPersonReport,
): boolean {
  return !report.adminAuthored &&
    (report.targetPubkey === definition.pubkey ||
      getCurrentModeratorPubkeys(definition).includes(report.targetPubkey));
}

function canPublishCommunityPersonReport(
  definition: CommunityDefinition,
  reporterPubkey: string,
  targetPubkey: string,
): boolean {
  const reporter = normalizePubkey(reporterPubkey);
  const target = normalizePubkey(targetPubkey);

  if (!reporter || !target || reporter === target) return false;
  if (
    reporter !== definition.pubkey &&
    (target === definition.pubkey ||
      getCurrentModeratorPubkeys(definition).includes(target))
  ) {
    return false;
  }
  if (reporter === definition.pubkey) return true;

  return getAllSectionModeratorPubkeys(definition).includes(reporter);
}

function isAuthorizedPersonReport(
  definition: CommunityDefinition,
  report: ParsedCommunityPersonReport,
): boolean {
  return canPublishCommunityPersonReport(
    definition,
    report.reporterPubkey,
    report.targetPubkey,
  );
}

export function getEffectiveCommunityPersonBanPubkeys({
  definition,
  reportEvents,
  deleteEvents = [],
}: {
  definition: CommunityDefinition;
  reportEvents: NostrEvent[];
  deleteEvents?: NostrEvent[];
}): string[] {
  const parsedReports: ParsedCommunityPersonReport[] = [];

  for (const event of reportEvents) {
    if (isCommunityReportDeleted(event, deleteEvents)) continue;

    const report = parseCommunityPersonReport(event, definition);
    if (!report) continue;
    if (isProtectedModeratorTarget(definition, report)) continue;

    parsedReports.push(report);
  }

  let personReports: ParsedCommunityPersonReport[] = [];
  for (let index = 0; index < parsedReports.length; index += 1) {
    const nextPersonReports = parsedReports.filter((report) =>
      !isPersonBannedByReports(personReports, report.reporterPubkey) &&
      isAuthorizedPersonReport(definition, report)
    );
    const currentIds = personReports.map((report) => report.event.id).sort()
      .join(",");
    const nextIds = nextPersonReports.map((report) => report.event.id).sort()
      .join(",");

    personReports = nextPersonReports;
    if (currentIds === nextIds) break;
  }

  return Array.from(
    new Set(personReports.map((report) => report.targetPubkey)),
  );
}

export function buildCommunityWhitelist({
  definition,
  profileListEvents,
  reportEvents = [],
  deleteEvents = [],
  options,
}: {
  definition: CommunityDefinition;
  profileListEvents: NostrEvent[];
  reportEvents?: NostrEvent[];
  deleteEvents?: NostrEvent[];
  options: CommunityWhitelistBuildOptions;
}): CommunityWhitelistSnapshot {
  const pubkeys = new Set<string>();
  const profileListRefs = getProfileListRefs(definition);

  if (options.includeAuthorities) {
    pubkeys.add(definition.pubkey);
    for (const ref of profileListRefs) pubkeys.add(ref.pubkey);
  }

  for (const ref of profileListRefs) {
    const event = findAddressableEvent(ref, profileListEvents);
    for (const pubkey of getProfileListPubkeys(event)) pubkeys.add(pubkey);
  }

  const bannedPubkeys = options.applyPersonBans
    ? getEffectiveCommunityPersonBanPubkeys({
      definition,
      reportEvents,
      deleteEvents,
    })
    : [];

  for (const pubkey of bannedPubkeys) {
    if (pubkey !== definition.pubkey) pubkeys.delete(pubkey);
  }

  return {
    community: definition.pubkey,
    definitionId: definition.event.id,
    definitionCreated: definition.event.created_at,
    pubkeys: Array.from(pubkeys).sort(),
    bannedPubkeys: bannedPubkeys.toSorted(),
    profileListRefs,
  };
}

export function makeCommunityAddressTag(communityPubkey: string): string {
  return makeCommunityDefinitionAddress(communityPubkey);
}
