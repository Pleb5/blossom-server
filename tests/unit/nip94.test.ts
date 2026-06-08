import { assertEquals } from "@std/assert";
import { nip94Fields } from "../../src/utils/nip94.ts";

Deno.test("nip94Fields: emits core file metadata tags", () => {
  const fields = nip94Fields({
    url: "https://cdn.example.com/blob.png",
    sha256: "a".repeat(64),
    size: 1234,
    type: "Image/PNG",
  });

  assertEquals(fields.nip94, [
    ["url", "https://cdn.example.com/blob.png"],
    ["m", "image/png"],
    ["x", "a".repeat(64)],
    ["size", "1234"],
  ]);
});

Deno.test("nip94Fields: emits optional ox and dim tags", () => {
  const fields = nip94Fields({
    url: "https://cdn.example.com/optimized.webp",
    sha256: "b".repeat(64),
    size: 5678,
    type: "image/webp",
    originalSha256: "c".repeat(64),
    dim: "640x480",
  });

  assertEquals(fields.nip94, [
    ["url", "https://cdn.example.com/optimized.webp"],
    ["m", "image/webp"],
    ["x", "b".repeat(64)],
    ["size", "5678"],
    ["ox", "c".repeat(64)],
    ["dim", "640x480"],
  ]);
});
