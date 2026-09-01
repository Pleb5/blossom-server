/**
 * BUD-04: PUT /mirror — Mirror a blob from a remote URL
 *
 * Pipeline (main thread unless noted):
 *   1.  config.mirror.enabled check → 403
 *   2.  BUD-11 auth check (t="upload") → 401/403
 *   3.  Parse JSON body { url } → 400
 *   4.  Validate URL scheme (http/https only) → 400
 *   5.  SSRF guard: reject bare private/loopback IP addresses → 400
 *   6.  Pre-fetch pool check (pool.available === 0) → 503
 *   7.  Outbound fetch with AbortSignal.timeout → 502 on error/timeout
 *   8.  Non-2xx origin response → 502
 *   9.  Content-Length > maxSize → 413 (body never streamed to worker)
 *  10.  Content-Type allowlist check → 415
 *  11.  Dispatch response.body to upload worker (zero-copy stream transfer)
 *       → null (race) → 503
 *  12.  Await { hash, size } from worker
 *  13.  BUD-11 x-tag verification (post-hash, strict):
 *         - Auth present + 0 x tags → 403 (x tag is REQUIRED for PUT /mirror)
 *         - Auth present + x tags present but none matches hash → 403
 *  14.  Dedup guard: if blob already exists, skip rename, add owner, return descriptor
 *  15.  Atomic Deno.rename(tmpPath → <storageDir>/<hash>[.<ext>])
 *  16.  insertBlob() — metadata write
 *  17.  Return BlobDescriptor JSON 200
 *
 * Spam / overload protection layers:
 *   L1 — Pre-fetch pool check: no TCP connection opened when workers are full
 *   L2 — Connect and body-idle timeouts: hung origins release worker slots
 *   L3 — Content-Length gate: 413 before any body bytes flow to the worker
 *   L4 — No-queue pool policy: dispatch() → null → 503, zero accumulation
 */

import { Hono } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import type { Client } from "@libsql/client";
import { ulid } from "@std/ulid";
import { getBlob, hasBlob, insertBlob, isOwner } from "../db/blobs.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.ts";
import type { BlossomVariables } from "../middleware/auth.ts";
import { debug } from "../middleware/debug.ts";
import { errorResponse } from "../middleware/errors.ts";
import type { IBlobStorage } from "../storage/interface.ts";
import { getPool, WorkerJobError } from "../workers/pool.ts";
import type { Config } from "../config/schema.ts";
import { mimeToExt } from "../utils/mime.ts";
import { type Nip94Tag, nip94Tags, optionalNip94Tags } from "../utils/nip94.ts";
import { getBaseUrl, getBlobUrl } from "../utils/url.ts";
import { getFileRule } from "../prune/rules.ts";
import {
  requireCommunityWhitelist,
  requiresCommunityWhitelist,
} from "../access/guard.ts";
import { extractDimensions } from "../optimize/dimensions.ts";
import {
  assertPublicMirrorUrl,
  fetchPinnedMirrorUrl,
} from "../utils/mirror-url.ts";
import { withBodyDeadline } from "../utils/streams.ts";

/** BUD-02 Blob Descriptor (same shape as upload route) */
interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  /** Additional NIP-94 file metadata tags. */
  nip94?: Nip94Tag[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function fetchMirrorUrl(
  initialUrl: URL,
  connectTimeout: number,
  signal: AbortSignal,
): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicMirrorUrl(url);

    const controller = new AbortController();
    const fetchSignal = AbortSignal.any([signal, controller.signal]);
    const timer = connectTimeout > 0
      ? setTimeout(() => controller.abort(), connectTimeout)
      : null;
    let response: Response;
    try {
      response = await fetchPinnedMirrorUrl(url, fetchSignal);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Origin redirect is missing a Location header");
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error("Origin returned too many redirects");
    }
    url = new URL(location, url);
  }
  throw new Error("Origin returned too many redirects");
}

export function buildMirrorRouter(
  db: Client,
  storage: IBlobStorage,
  config: Config,
): Hono<{ Variables: BlossomVariables }> {
  const app = new Hono<{ Variables: BlossomVariables }>();

  app.put("/mirror", async (ctx) => {
    const reqId = ulid();
    const debugPrefix = `[mirror:${reqId}]`;

    if (!config.mirror.enabled) {
      await ctx.req.raw.body?.cancel();
      debug(debugPrefix, "rejected: mirroring disabled");
      return errorResponse(ctx, 403, "Mirroring is disabled on this server");
    }

    let auth: ReturnType<typeof requireAuth> | undefined;
    try {
      if (
        config.mirror.requireAuth || requiresCommunityWhitelist(config, "write")
      ) {
        auth = requireAuth(ctx, "upload");
      } else {
        // Auth is optional — capture it if present for owner registration
        auth = optionalAuth(ctx, "upload");
      }
    } catch (err) {
      await ctx.req.raw.body?.cancel();
      const msg = err instanceof HTTPException ? err.message : String(err);
      debug(debugPrefix, `rejected: auth failed — ${msg}`);
      if (err instanceof HTTPException) {
        return errorResponse(ctx, err.status as 401 | 403, err.message);
      }
      throw err;
    }

    const accessError = await requireCommunityWhitelist(
      ctx,
      db,
      config,
      "write",
      auth,
    );
    if (accessError) {
      await ctx.req.raw.body?.cancel();
      debug(
        debugPrefix,
        `rejected: community access failed — ${
          accessError.headers.get("X-Reason") ?? accessError.status
        }`,
      );
      return accessError;
    }

    let mirrorUrl: URL;
    try {
      const body = (await ctx.req.json()) as { url?: unknown };
      if (!body.url || typeof body.url !== "string") {
        debug(debugPrefix, "rejected: missing url field in body");
        return errorResponse(
          ctx,
          400,
          'Request body must be a JSON object with a "url" string field',
        );
      }
      mirrorUrl = new URL(body.url);
    } catch {
      debug(debugPrefix, "rejected: invalid JSON body");
      return errorResponse(
        ctx,
        400,
        "Invalid request body: expected JSON { url: string }",
      );
    }

    debug(
      debugPrefix,
      `PUT /mirror — url=${mirrorUrl.toString()} pubkey=${
        auth?.pubkey?.slice(0, 8) ?? "anon"
      }`,
    );

    try {
      await assertPublicMirrorUrl(mirrorUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Invalid mirror URL";
      debug(debugPrefix, `rejected: SSRF guard — ${reason}`);
      return errorResponse(ctx, 400, reason);
    }

    if (getPool().available === 0) {
      debug(debugPrefix, "rejected: all upload workers busy (pre-fetch)");
      return errorResponse(
        ctx,
        503,
        "Server busy. All upload workers are occupied. Try again shortly.",
      );
    }

    debug(
      debugPrefix,
      `fetching origin url=${mirrorUrl.toString()} connectTimeout=${config.mirror.connectTimeout}ms bodyTimeout=${config.mirror.bodyTimeout}ms`,
    );
    const t0 = Date.now();
    let originResponse: Response;
    const originAbort = new AbortController();
    try {
      originResponse = await fetchMirrorUrl(
        mirrorUrl,
        config.mirror.connectTimeout,
        originAbort.signal,
      );
      const t1 = Date.now();
      debug(
        debugPrefix,
        `origin responded status=${originResponse.status} elapsed=${t1 - t0}ms`,
      );
    } catch (err) {
      const t1 = Date.now();
      // Normalise error message — DOMException.message can be empty.
      const reason = err instanceof Error
        ? err.message || `Fetch aborted (${err.name})`
        : `Failed to fetch from origin: ${String(err)}`;
      debug(debugPrefix, `fetch failed elapsed=${t1 - t0}ms — ${reason}`);
      return errorResponse(ctx, 502, reason);
    }

    if (!originResponse.ok) {
      await originResponse.body?.cancel();
      debug(
        debugPrefix,
        `rejected: origin ${originResponse.status} ${originResponse.statusText}`,
      );
      return errorResponse(
        ctx,
        502,
        `Origin server returned ${originResponse.status} ${originResponse.statusText}`,
      );
    }

    const contentLengthHeader = originResponse.headers.get("content-length");
    const contentLength = contentLengthHeader
      ? parseInt(contentLengthHeader, 10)
      : null;
    if (
      contentLength !== null && !isNaN(contentLength) &&
      contentLength > config.upload.maxSize
    ) {
      await originResponse.body?.cancel();
      debug(
        debugPrefix,
        `rejected: remote blob too large — ${contentLength} > ${config.upload.maxSize} bytes`,
      );
      return errorResponse(
        ctx,
        413,
        `Remote blob too large. Maximum allowed size is ${config.upload.maxSize} bytes`,
      );
    }

    const rawContentType = originResponse.headers.get("content-type") ??
      "application/octet-stream";
    const mimeType = rawContentType.split(";")[0].trim() ||
      "application/octet-stream";

    debug(
      debugPrefix,
      `origin content-type=${mimeType} content-length=${
        contentLength ?? "unknown"
      }`,
    );

    const mimeRule = getFileRule(
      { mimeType, pubkey: auth?.pubkey },
      config.storage.rules,
      config.upload.requirePubkeyInRule,
    );
    if (!mimeRule) {
      await originResponse.body?.cancel();
      debug(
        debugPrefix,
        `rejected: no storage rule matches — mime=${mimeType}`,
      );
      if (config.upload.requirePubkeyInRule) {
        return errorResponse(
          ctx,
          401,
          "Pubkey not authorized by any storage rule",
        );
      }
      return errorResponse(
        ctx,
        415,
        `Server does not accept ${mimeType} blobs`,
      );
    }

    const body = originResponse.body;
    if (!body) {
      debug(debugPrefix, "rejected: origin returned empty body");
      return errorResponse(ctx, 502, "Origin server returned an empty body");
    }

    const deadline = withBodyDeadline(
      body,
      config.mirror.bodyTimeout,
      `Mirror body made no progress for ${config.mirror.bodyTimeout}ms`,
    );
    const streamForWorker = deadline.stream;

    const pool = getPool();
    let session;
    try {
      session = await storage.beginWrite(contentLength);
    } catch (err) {
      deadline.cancel(err);
      originAbort.abort(err);
      throw err;
    }

    debug(
      debugPrefix,
      `dispatching to worker — size=${
        contentLength ?? "unknown"
      } mime=${mimeType}`,
    );

    // Pass null as xSha256 — the hash is unknown pre-download. The x-tag
    // verification happens post-hash (step 13) after the worker returns.
    const jobPromise = pool.dispatch(
      streamForWorker,
      session.tmpPath,
      contentLength,
      null,
      config.upload.maxSize,
    );
    if (!jobPromise) {
      // Race: another request claimed the last worker between step 6 and now.
      deadline.cancel();
      originAbort.abort(new Error("No upload worker available"));
      await storage.abortWrite(session).catch(() => {});
      debug(
        debugPrefix,
        "rejected: worker race — all workers claimed before dispatch",
      );
      return errorResponse(
        ctx,
        503,
        "Server busy. All upload workers are occupied. Try again shortly.",
      );
    }

    let hash: string;
    let size: number;
    debug(debugPrefix, "awaiting worker result");
    try {
      ({ hash, size } = await jobPromise);
      deadline.clear();
      debug(
        debugPrefix,
        `worker complete — hash=${hash.slice(0, 8)} size=${size}`,
      );
    } catch (err) {
      // Worker already deleted session.tmpPath on failure.
      deadline.cancel(err);
      originAbort.abort(err);
      await storage.abortWrite(session).catch(() => {});
      // DOMException (e.g. TimeoutError from AbortSignal) has a non-empty
      // .name but may have an empty .message — use name as fallback.
      const errName = err instanceof Error ? err.name : "";
      const errMsg = err instanceof Error
        ? err.message || err.name
        : String(err);
      const isBodyTimeout = errName === "TimeoutError" &&
        config.mirror.bodyTimeout > 0;
      const msg = isBodyTimeout
        ? `Mirror body made no progress for ${config.mirror.bodyTimeout}ms`
        : errMsg || "Mirror failed";
      debug(debugPrefix, `worker error — ${msg}`);
      if (err instanceof WorkerJobError && err.errorType === "TOO_LARGE") {
        return errorResponse(ctx, 413, msg);
      }
      return errorResponse(ctx, 502, msg);
    }

    if (auth) {
      const xTags = auth.tags.filter((t) => t[0] === "x");
      if (xTags.length === 0) {
        await storage.abortWrite(session).catch(() => {});
        debug(
          debugPrefix,
          `rejected: auth event missing x tag for hash=${hash.slice(0, 8)}`,
        );
        return errorResponse(
          ctx,
          403,
          "Auth event is missing required x tag for PUT /mirror",
        );
      }
      if (!xTags.some((t) => t[1] === hash)) {
        await storage.abortWrite(session).catch(() => {});
        debug(
          debugPrefix,
          `rejected: x tag mismatch — hash=${
            hash.slice(0, 8)
          } not in auth tags`,
        );
        return errorResponse(
          ctx,
          403,
          "Mirrored content does not match the authorized hash",
        );
      }
    }

    const ext = mimeToExt(mimeType);

    if (await hasBlob(db, hash)) {
      await storage.abortWrite(session).catch(() => {});
      const existing = await getBlob(db, hash);
      if (existing) {
        debug(
          debugPrefix,
          `dedup hit — returning existing blob ${hash.slice(0, 8)}`,
        );
        if (auth && !(await isOwner(db, hash, auth.pubkey))) {
          await insertBlob(db, existing, auth.pubkey);
        }
        const baseUrl = getBaseUrl(ctx.req.raw, config.publicDomain);
        const url = getBlobUrl(existing.sha256, existing.type, baseUrl);
        const type = existing.type ?? "application/octet-stream";
        return ctx.json(
          {
            url,
            sha256: existing.sha256,
            size: existing.size,
            type,
            uploaded: existing.uploaded,
            nip94: nip94Tags({
              url,
              sha256: existing.sha256,
              size: existing.size,
              type,
              tags: existing.nip94,
            }),
          } satisfies BlobDescriptor,
        );
      }
    }

    const blobType = mimeType !== "application/octet-stream" ? mimeType : null;
    const dim = await extractDimensions(session.tmpPath, blobType);
    debug(debugPrefix, `dim=${dim ?? "none"}`);

    debug(debugPrefix, `commitWrite start hash=${hash} ext=${ext}`);
    const t2 = Date.now();
    try {
      await storage.commitWrite(session, hash, ext);
      const t3 = Date.now();
      debug(debugPrefix, `commitWrite complete elapsed=${t3 - t2}ms`);
    } catch (err) {
      originAbort.abort(err);
      await storage.abortWrite(session).catch(() => {});
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const blobRecord = {
      sha256: hash,
      size,
      type: blobType,
      uploaded: now,
      nip94: optionalNip94Tags({ dim }),
    };
    debug(debugPrefix, `insertBlob start hash=${hash}`);
    const t4 = Date.now();
    await insertBlob(db, blobRecord, auth?.pubkey ?? "anonymous");
    const t5 = Date.now();
    debug(debugPrefix, `insertBlob complete elapsed=${t5 - t4}ms`);

    debug(
      debugPrefix,
      `mirror complete — ${hash} (${size} bytes, ${
        blobRecord.type ?? "application/octet-stream"
      })`,
    );
    const baseUrl = getBaseUrl(ctx.req.raw, config.publicDomain);
    const url = getBlobUrl(hash, blobRecord.type, baseUrl);
    const type = blobRecord.type ?? "application/octet-stream";
    return ctx.json(
      {
        url,
        sha256: hash,
        size,
        type,
        uploaded: now,
        nip94: nip94Tags({
          url,
          sha256: hash,
          size,
          type,
          tags: blobRecord.nip94,
        }),
      } satisfies BlobDescriptor,
      201,
    );
  });

  return app;
}
