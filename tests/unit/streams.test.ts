import { assertEquals, assertRejects } from "@std/assert";
import { withBodyDeadline } from "../../src/utils/streams.ts";

Deno.test("withBodyDeadline errors a stalled body", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
  });
  const deadline = withBodyDeadline(body, 5, "body deadline reached");
  await assertRejects(
    () => deadline.stream.getReader().read(),
    Error,
    "body deadline reached",
  );
});

Deno.test("withBodyDeadline preserves a completed body", async () => {
  const expected = new TextEncoder().encode("complete");
  const deadline = withBodyDeadline(
    new Blob([expected]).stream(),
    1_000,
    "too slow",
  );
  const actual = new Uint8Array(
    await new Response(deadline.stream).arrayBuffer(),
  );
  deadline.clear();
  assertEquals(actual, expected);
});

Deno.test("withBodyDeadline cancel releases the source", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const deadline = withBodyDeadline(body, 1_000, "too slow");
  deadline.cancel();
  await assertRejects(() => deadline.stream.getReader().read());
  assertEquals(cancelled, true);
});
