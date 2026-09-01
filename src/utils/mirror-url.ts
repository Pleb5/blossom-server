type DnsResolver = (
  hostname: string,
  recordType: "A" | "AAAA",
) => Promise<string[]>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function parseIpv6(address: string): number[] | null {
  let value = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const embeddedIpv4 = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const bytes = parseIpv4(embeddedIpv4);
    if (!bytes) return null;
    value = value.slice(0, -embeddedIpv4.length) +
      `${((bytes[0] << 8) | bytes[1]).toString(16)}:${
        ((bytes[2] << 8) | bytes[3]).toString(16)
      }`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) return null;

  return groups.flatMap((group) => {
    const word = parseInt(group, 16);
    return [word >> 8, word & 0xff];
  });
}

export function isPublicIpAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;

  // Only globally routable unicast space is accepted. Explicitly exclude the
  // documentation prefix even though it lies inside 2000::/3.
  const globalUnicast = (ipv6[0] & 0xe0) === 0x20;
  const documentation = ipv6[0] === 0x20 && ipv6[1] === 0x01 &&
    ipv6[2] === 0x0d && ipv6[3] === 0xb8;
  return globalUnicast && !documentation;
}

const defaultResolver: DnsResolver = async (hostname, recordType) => {
  return await Deno.resolveDns(hostname, recordType) as string[];
};

function validateMirrorUrl(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Mirror URL must not contain credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Mirror URL resolves to a non-public address");
  }
  return hostname;
}

export async function assertPublicMirrorUrl(
  url: URL,
  resolver: DnsResolver = defaultResolver,
): Promise<void> {
  await resolvePublicMirrorAddress(url, resolver);
}

/** Resolve once, validate every answer, and return the address to connect to. */
export async function resolvePublicMirrorAddress(
  url: URL,
  resolver: DnsResolver = defaultResolver,
): Promise<string> {
  const hostname = validateMirrorUrl(url);

  if (parseIpv4(hostname) || parseIpv6(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error("Mirror URL resolves to a non-public address");
    }
    return hostname;
  }

  const results = await Promise.allSettled([
    resolver(hostname, "A"),
    resolver(hostname, "AAAA"),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (addresses.length === 0) {
    throw new Error("Mirror URL hostname did not resolve");
  }
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("Mirror URL resolves to a non-public address");
  }
  return addresses[0];
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readHeader(conn: Deno.Conn): Promise<Uint8Array> {
  let bytes = new Uint8Array(0);
  const chunk = new Uint8Array(4096);
  while (bytes.byteLength < 64 * 1024) {
    const count = await conn.read(chunk);
    if (count === null) throw new Error("Mirror proxy connection closed");
    const combined = new Uint8Array(bytes.byteLength + count);
    combined.set(bytes);
    combined.set(chunk.subarray(0, count), bytes.byteLength);
    bytes = combined;
    if (decoder.decode(bytes).includes("\r\n\r\n")) return bytes;
  }
  throw new Error("Mirror proxy request headers are too large");
}

async function connectWithSignal(
  options: Deno.ConnectOptions,
  signal?: AbortSignal,
): Promise<Deno.TcpConn> {
  if (!signal) return await Deno.connect(options);
  signal.throwIfAborted();

  const connect = Deno.connect(options);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  try {
    return await Promise.race([connect, aborted]);
  } catch (err) {
    // Deno.connect cannot be cancelled. Close a socket that completes after the
    // abort so it cannot linger as an unreferenced connection.
    connect.then((conn) => conn.close()).catch(() => {});
    throw err;
  }
}

async function proxyPinnedConnection(
  client: Deno.Conn,
  url: URL,
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  let upstream: Deno.Conn | null = null;
  try {
    const initial = await readHeader(client);
    const decoded = decoder.decode(initial);
    const headerEnd = decoded.indexOf("\r\n\r\n") + 4;
    const text = decoded.slice(0, headerEnd);
    const firstLineEnd = text.indexOf("\r\n");
    const firstLine = text.slice(0, firstLineEnd);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    upstream = await connectWithSignal({ hostname: address, port }, signal);

    if (firstLine.startsWith("CONNECT ")) {
      const authority = firstLine.split(" ")[1];
      const expectedAuthority = `${url.hostname}:${port}`;
      if (authority !== expectedAuthority) {
        throw new Error("Mirror proxy target mismatch");
      }
      await writeAll(
        client,
        encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"),
      );
      const extra = initial.subarray(headerEnd);
      if (extra.byteLength > 0) await writeAll(upstream, extra);
    } else {
      const match = firstLine.match(/^(\S+)\s+(\S+)\s+(HTTP\/\d\.\d)$/);
      if (!match) throw new Error("Invalid mirror proxy request");
      const requestUrl = new URL(match[2]);
      if (
        requestUrl.hostname !== url.hostname || requestUrl.port !== url.port
      ) {
        throw new Error("Mirror proxy target mismatch");
      }
      const target = `${requestUrl.pathname}${requestUrl.search}` || "/";
      const rewritten = `${match[1]} ${target} ${match[3]}${
        text.slice(firstLineEnd)
      }`;
      await writeAll(upstream, encoder.encode(rewritten));
      const extra = initial.subarray(headerEnd);
      if (extra.byteLength > 0) await writeAll(upstream, extra);
    }

    await Promise.allSettled([
      client.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(client.writable),
    ]);
  } finally {
    try {
      upstream?.close();
    } catch { /* already closed */ }
    try {
      client.close();
    } catch { /* already closed */ }
  }
}

/**
 * Fetch through a one-shot loopback proxy whose upstream socket is pinned to
 * the validated DNS answer. HTTPS remains end-to-end, so fetch still verifies
 * the original hostname and supplies its SNI and Host header.
 */
export async function fetchPinnedMirrorUrl(
  url: URL,
  signal?: AbortSignal,
): Promise<Response> {
  const address = await resolvePublicMirrorAddress(url);
  const proxyAbort = new AbortController();
  const abortProxy = () => proxyAbort.abort(signal?.reason);
  signal?.addEventListener("abort", abortProxy, { once: true });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const proxyPort = (listener.addr as Deno.NetAddr).port;
  const proxyTask = (async () => {
    const client = await listener.accept();
    listener.close();
    await proxyPinnedConnection(client, url, address, proxyAbort.signal);
  })().catch(() => {
    try {
      listener.close();
    } catch { /* already closed */ }
  });
  const httpClient = Deno.createHttpClient({
    proxy: { url: `http://127.0.0.1:${proxyPort}` },
  });

  try {
    const init = {
      redirect: "manual",
      signal,
      client: httpClient,
    } as RequestInit & { client: Deno.HttpClient };
    const response = await fetch(url, init);
    if (!response.body) {
      signal?.removeEventListener("abort", abortProxy);
      proxyAbort.abort();
      httpClient.close();
      await proxyTask;
      return response;
    }

    const reader = response.body.getReader();
    const cleanup = async () => {
      signal?.removeEventListener("abort", abortProxy);
      proxyAbort.abort();
      httpClient.close();
      await proxyTask;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            await cleanup();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
          await cleanup();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        await cleanup();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    signal?.removeEventListener("abort", abortProxy);
    proxyAbort.abort(err);
    httpClient.close();
    try {
      listener.close();
    } catch { /* already closed */ }
    await proxyTask;
    throw err;
  }
}
