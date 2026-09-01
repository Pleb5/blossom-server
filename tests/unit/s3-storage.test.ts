import { assertEquals } from "@std/assert";
import { S3Storage } from "../../src/storage/s3.ts";

Deno.test("S3Storage builds configured public object URLs", () => {
  const storage = new S3Storage({
    endpoint: "https://s3.example.com",
    bucket: "blobs",
    accessKey: "test",
    secretKey: "test",
    publicURL: "https://cdn.example.com/blobs/",
    tmpDir: "/tmp",
  });

  assertEquals(
    storage.publicUrl("a".repeat(64), "jpg"),
    `https://cdn.example.com/blobs/${"a".repeat(64)}.jpg`,
  );
});
