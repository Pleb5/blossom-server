import { assertEquals, assertRejects } from "@std/assert";
import { ConfigSchema } from "../../src/config/schema.ts";
import { optimizeMedia } from "../../src/optimize/index.ts";
import { createThumbnail } from "../../src/optimize/thumbnail.ts";

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
