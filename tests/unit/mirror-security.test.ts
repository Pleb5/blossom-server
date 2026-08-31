import { assertEquals, assertRejects } from "@std/assert";
import {
  assertPublicMirrorUrl,
  isPublicIpAddress,
} from "../../src/utils/mirror-url.ts";

Deno.test("isPublicIpAddress rejects private and special addresses", () => {
  for (
    const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "198.18.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]
  ) {
    assertEquals(isPublicIpAddress(address), false, address);
  }
});

Deno.test("isPublicIpAddress accepts public addresses", () => {
  assertEquals(isPublicIpAddress("1.1.1.1"), true);
  assertEquals(isPublicIpAddress("2606:4700:4700::1111"), true);
});

Deno.test("assertPublicMirrorUrl rejects credentials and private DNS results", async () => {
  await assertRejects(
    () => assertPublicMirrorUrl(new URL("https://user@example.com/file")),
    Error,
    "credentials",
  );
  await assertRejects(
    () =>
      assertPublicMirrorUrl(
        new URL("https://example.com/file"),
        (_hostname, type) => Promise.resolve(type === "A" ? ["127.0.0.1"] : []),
      ),
    Error,
    "non-public",
  );
});

Deno.test("assertPublicMirrorUrl accepts hostnames with only public results", async () => {
  await assertPublicMirrorUrl(
    new URL("https://example.com/file"),
    (_hostname, type) =>
      Promise.resolve(
        type === "A"
          ? ["93.184.216.34"]
          : ["2606:2800:220:1::248:1893:25c8:1946"],
      ),
  );
});
