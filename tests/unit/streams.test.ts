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

Deno.test("withBodyDeadline resets its timeout when bytes arrive", async () => {
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      controller.enqueue(new Uint8Array([++chunks]));
      if (chunks === 4) controller.close();
    },
  });
  const deadline = withBodyDeadline(body, 40, "stalled");
  const bytes = new Uint8Array(
    await new Response(deadline.stream).arrayBuffer(),
  );
  assertEquals(bytes, new Uint8Array([1, 2, 3, 4]));
});

Deno.test("withBodyDeadline with timeout zero still cancels its source", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const deadline = withBodyDeadline(body, 0, "unused");
  deadline.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(cancelled, true);
});
