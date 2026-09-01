import { assertEquals, assertRejects } from "@std/assert";
import { ConfigSchema } from "../../src/config/schema.ts";
import { optimizeMedia } from "../../src/optimize/index.ts";
import { createThumbnail } from "../../src/optimize/thumbnail.ts";
import { commitMediaFile } from "../../src/routes/media.ts";
import type { IBlobStorage } from "../../src/storage/interface.ts";

async function entries(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names;
}

Deno.test("media optimizers remove output files when processing fails", async () => {
  const root = await Deno.makeTempDir();
  const tmpDir = `${root}/outputs`;
  await Deno.mkdir(tmpDir);
  const input = `${root}/invalid.png`;
  await Deno.writeTextFile(input, "not a png");
  const config = ConfigSchema.parse({ media: { tmpDir } }).media;

  try {
    await assertRejects(() => optimizeMedia(input, config));
    assertEquals(await entries(tmpDir), []);

    await assertRejects(
      () => createThumbnail(input, "image/png", config.thumbnail, tmpDir),
    );
    assertEquals(await entries(tmpDir), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("media storage commit is rolled back when DB metadata fails", async () => {
  const calls: string[] = [];
  const storage = {
    has: () => Promise.resolve(false),
    commitFile: (_path: string, hash: string, ext: string) => {
      calls.push(`commit:${hash}.${ext}`);
      return Promise.resolve();
    },
    remove: (hash: string, ext: string) => {
      calls.push(`remove:${hash}.${ext}`);
      return Promise.resolve(true);
    },
  } as unknown as IBlobStorage;

  await assertRejects(
    () =>
      commitMediaFile(storage, "/tmp/output", "optimized", "webp", () => {
        throw new Error("database unavailable");
      }),
    Error,
    "database unavailable",
  );
  await assertRejects(() =>
    commitMediaFile(storage, "/tmp/thumb", "thumbnail", "webp", () => {
      throw new Error("database unavailable");
    })
  );
  assertEquals(calls, [
    "commit:optimized.webp",
    "remove:optimized.webp",
    "commit:thumbnail.webp",
    "remove:thumbnail.webp",
  ]);
});

Deno.test("media rollback does not remove a pre-existing storage object", async () => {
  let removed = false;
  const storage = {
    has: () => Promise.resolve(true),
    commitFile: () => Promise.resolve(),
    remove: () => {
      removed = true;
      return Promise.resolve(true);
    },
  } as unknown as IBlobStorage;

  await assertRejects(() =>
    commitMediaFile(storage, "/tmp/thumbnail", "thumbnail", "webp", () => {
      throw new Error("database unavailable");
    })
  );
  assertEquals(removed, false);
});
