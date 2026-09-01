import { assertEquals, assertRejects } from "@std/assert";
import { createClient } from "@libsql/client";
import { UploadWorkerPool, WorkerJobError } from "../../src/workers/pool.ts";

Deno.test({
  name: "upload worker cancels an oversized stream and remains reusable",
  async fn() {
    const db = createClient({ url: ":memory:" });
    const pool = new UploadWorkerPool(1, 1, 1_000, db, {
      path: ":memory:",
    });
    const dir = await Deno.makeTempDir();
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });

    try {
      await assertRejects(
        () => pool.dispatch(oversized, `${dir}/oversized`, null, null, 1)!,
        WorkerJobError,
        "maximum size",
      );
      assertEquals(cancelled, true);

      const result = await pool.dispatch(
        new Blob([new Uint8Array([1, 2, 3])]).stream(),
        `${dir}/recovery`,
        3,
        null,
        3,
      );
      assertEquals(result?.size, 3);
    } finally {
      pool.shutdown();
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
