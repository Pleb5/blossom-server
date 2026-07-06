import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { normalizeRelays } from "./community.ts";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

function makeSubId(): string {
  return `blossom-${crypto.randomUUID()}`;
}

function isVerifiedEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  try {
    return verifyEvent(value as NostrEvent);
  } catch {
    return false;
  }
}

export async function fetchRelayEvents(
  relay: string,
  filters: NostrFilter[],
  timeoutMs: number,
): Promise<NostrEvent[]> {
  if (filters.length === 0) return [];

  const subId = makeSubId();
  const events: NostrEvent[] = [];
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ws: WebSocket | undefined;

  const finish = (resolve: (events: NostrEvent[]) => void) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["CLOSE", subId]));
      }
      ws?.close();
    } catch {
      // The relay may already have closed the socket.
    }
    resolve(events);
  };

  return await new Promise<NostrEvent[]>((resolve) => {
    try {
      ws = new WebSocket(relay);
    } catch {
      resolve([]);
      return;
    }

    timeout = setTimeout(() => finish(resolve), timeoutMs);

    ws.onopen = () => {
      const socket = ws;
      if (!socket) {
        finish(resolve);
        return;
      }
      try {
        socket.send(JSON.stringify(["REQ", subId, ...filters]));
      } catch {
        finish(resolve);
      }
    };

    ws.onmessage = (message) => {
      if (typeof message.data !== "string") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }

      if (!Array.isArray(parsed) || parsed[1] !== subId) return;

      if (parsed[0] === "EVENT" && isVerifiedEvent(parsed[2])) {
        events.push(parsed[2]);
        return;
      }

      if (parsed[0] === "EOSE" || parsed[0] === "CLOSED") {
        finish(resolve);
      }
    };

    ws.onerror = () => finish(resolve);
    ws.onclose = () => finish(resolve);
  });
}

export async function fetchNostrEvents(
  relays: string[],
  filters: NostrFilter[],
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const normalizedRelays = normalizeRelays(relays);
  if (normalizedRelays.length === 0 || filters.length === 0) return [];

  const results = await Promise.all(
    normalizedRelays.map((relay) =>
      fetchRelayEvents(relay, filters, timeoutMs).catch(() =>
        [] as NostrEvent[]
      )
    ),
  );

  return Array.from(
    new Map(results.flat().map((event) => [event.id, event])).values(),
  );
}
