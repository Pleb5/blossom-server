type DnsResolver = (
  hostname: string,
  recordType: "A" | "AAAA",
) => Promise<string[]>;

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

export async function assertPublicMirrorUrl(
  url: URL,
  resolver: DnsResolver = defaultResolver,
): Promise<void> {
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

  if (parseIpv4(hostname) || parseIpv6(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error("Mirror URL resolves to a non-public address");
    }
    return;
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
}
