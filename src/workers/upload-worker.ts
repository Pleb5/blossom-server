/// <reference lib="deno.worker" />
import { sha256 } from "@noble/hashes/sha256";
import { encodeHex } from "@std/encoding/hex";
import { DbProxy } from "../db/proxy.ts";
import { DirectDbHandle } from "../db/direct.ts";
import type { IDbHandle } from "../db/handle.ts";

let _db: IDbHandle | null = null;

let _bytesThisWindow = 0;

interface InitMessageLocal {
  type: "init";
  dbMode: "local";
  dbPort: MessagePort;
  throughputWindowMs: number;
}

interface InitMessageRemote {
  type: "init";
  dbMode: "remote";
  dbUrl: string;
  dbAuthToken?: string;
  throughputWindowMs: number;
}

type InitMessage = InitMessageLocal | InitMessageRemote;

interface JobMessage {
  type: "job";
  id: string;
  stream: ReadableStream<Uint8Array>;
  tmpPath: string;
  sizeHint: number | null;
  xSha256: string | null;
  maxBytes: number;
}

interface JobSuccess {
  id: string;
  hash: string;
  size: number;
}

/** Discriminated error types for status code mapping on the main thread. */
type WorkerErrorType =
  | "HASH_MISMATCH"
  | "TOO_LARGE"
  | "WRITE_ERROR"
  | "UNKNOWN";

class SizeLimitError extends Error {}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    written += await file.write(chunk.subarray(written));
  }
}

interface JobError {
  id: string;
  error: string;
  errorType: WorkerErrorType;
}

interface ThroughputReport {
  type: "throughput";
  bytesPerSec: number;
}

self.onmessage = async (event: MessageEvent<InitMessage | JobMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    if (msg.dbMode === "local") {
      _db = new DbProxy(msg.dbPort);
    } else {
      const { createClient } = await import("@libsql/client");
      const client = createClient({
        url: msg.dbUrl,
        authToken: msg.dbAuthToken,
      });
      _db = new DirectDbHandle(client);
    }

    const windowMs = msg.throughputWindowMs;
    setInterval(() => {
      const bytesPerSec = Math.round(_bytesThisWindow * (1_000 / windowMs));
      _bytesThisWindow = 0;
      self.postMessage(
        { type: "throughput", bytesPerSec } satisfies ThroughputReport,
      );
    }, windowMs);

    return;
  }
  if (msg.type === "job") {
    await handleJob(msg);
  }
};

async function handleJob(msg: JobMessage): Promise<void> {
  const { id, stream, tmpPath, xSha256, maxBytes } = msg;

  let file: Deno.FsFile | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    file = await Deno.open(tmpPath, {
      write: true,
      create: true,
      truncate: true,
    });

    let totalSize = 0;
    const digest = sha256.create();
    reader = stream.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        totalSize += chunk.byteLength;
        if (totalSize > maxBytes) {
          throw new SizeLimitError(
            `Upload exceeds maximum size of ${maxBytes} bytes`,
          );
        }
        _bytesThisWindow += chunk.byteLength;
        digest.update(chunk);
        await writeAll(file, chunk);
      }
    } finally {
      reader.releaseLock();
      reader = null;
    }
    file.close();
    file = null;

    const hash = encodeHex(digest.digest());

    // Verify against declared hash if provided
    if (xSha256 !== null && hash !== xSha256) {
      await Deno.remove(tmpPath).catch(() => {});
      self.postMessage(
        {
          id,
          error: `Hash mismatch: declared ${xSha256}, computed ${hash}`,
          errorType: "HASH_MISMATCH",
        } satisfies JobError,
      );
      return;
    }

    self.postMessage({ id, hash, size: totalSize } satisfies JobSuccess);
  } catch (err) {
    if (reader) {
      await reader.cancel(err).catch(() => {});
      reader.releaseLock();
    } else if (!stream.locked) {
      await stream.cancel(err).catch(() => {});
    }
    try {
      file?.close();
    } catch { /* already closed */ }
    await Deno.remove(tmpPath).catch(() => {});
    self.postMessage(
      {
        id,
        error: err instanceof Error ? err.message : String(err),
        errorType: err instanceof SizeLimitError ? "TOO_LARGE" : "UNKNOWN",
      } satisfies JobError,
    );
  }
}
