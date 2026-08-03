// Skylab direct-API client (WORKPLAN §1.6).
//
// Skylab (lab diamonds) is ending its Fantasy relationship, so the Fantasy-hosted
// FTP feed we currently ingest for Skylab will die. This client pulls Skylab's own
// stock API instead. It is a single authenticated GET that returns the full book in
// one response (no pagination, no rate limit per Skylab's tech lead), which matches
// our full-snapshot ingest model.
//
// API doc: RADIIA_Stock_API_Documentation — GET /users/radiia-list, header
// `x-api-key: <key>`. Response: { success, count, data: [...stones] }. Refreshes
// roughly every 2h on Skylab's side, so a live/on-memo/sold change can lag up to
// that long — acceptable and still a large improvement over the FTP feed, which
// carried no availability signal at all.

import { z } from "zod";

import { env } from "../../env";

// Numeric fields arrive as either JSON numbers (weight: 7.02) or strings
// ("800632501"); id-like fields likewise. Accept both, plus null; the adapter
// coerces. Unknown/extra fields are stripped by default — we only read what we map.
const numeric = z.union([z.string(), z.number()]).nullable().optional();
const text = z.string().nullable().optional();

// One stone as returned by /users/radiia-list. Field names/shape per the API doc +
// the sample payload (info/7-13 shared files/image.png). All fields are optional so
// a v1 vendor API that omits a field on some rows never fails the whole parse; the
// adapter enforces what is actually required (a lot number or certificate).
export const SkylabStoneSchema = z.object({
  lot_no: numeric,
  lot_status: text,
  shape: text,
  color: text,
  clarity: text,
  hearts_and_arrows: text,
  weight: numeric,
  lab: text,
  cut_grade: text,
  polish: text,
  symmetry: text,
  fluor: text,
  rapaport: numeric,
  off_rap_percent: numeric,
  price_per_carat: numeric,
  certificate: numeric,
  length: numeric,
  width: numeric,
  depth: numeric,
  depth_percent: numeric,
  table_percent: numeric,
  girdle: text,
  culet: text,
  description: text,
  origin: text,
  measurement: text,
  certificate_link: text,
  video_link: text,
  image_link: text,
  html_link: text
});

export type SkylabStone = z.infer<typeof SkylabStoneSchema>;

const SkylabResponseSchema = z.object({
  success: z.boolean().optional(),
  count: z.number().optional(),
  data: z.array(SkylabStoneSchema)
});

export type SkylabFetchResult = {
  success: boolean | null;
  count: number | null;
  stones: SkylabStone[];
};

// Transient-failure retry. Skylab's gateway intermittently 5xx's — one 502 used to
// fail the entire run and email the operator, even though the next 15-min tick
// succeeded unaided. Only infrastructure-shaped failures are worth another attempt:
// a network error/timeout, a 5xx, or a 429. A 401 (wrong key), any other 4xx, and a
// body that doesn't parse or doesn't match the schema are real problems that more
// attempts cannot fix, so those still throw on the first try. Retries are marked by
// wrapping the error rather than re-inspecting its message.
class TransientSkylabError extends Error {}

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One attempt. Throws TransientSkylabError for anything retryable, a plain Error
// otherwise.
async function fetchSkylabStockOnce(url: string): Promise<SkylabFetchResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": env.skylabApiKey, accept: "application/json" },
      signal: AbortSignal.timeout(env.skylabApiTimeoutMs)
    });
  } catch (err) {
    // Connection reset, DNS blip, or our own timeout firing — all worth retrying.
    const reason = err instanceof Error ? err.message : String(err);
    throw new TransientSkylabError(`Skylab API request to ${url} failed: ${reason}`);
  }

  if (res.status === 401) {
    throw new Error("Skylab API returned 401 Unauthorized — check SKYLAB_API_KEY.");
  }
  if (res.status >= 500 || res.status === 429) {
    throw new TransientSkylabError(`Skylab API returned HTTP ${res.status} from ${url}.`);
  }
  if (!res.ok) {
    throw new Error(`Skylab API returned HTTP ${res.status} from ${url}.`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Skylab API returned a non-JSON body: ${reason}`);
  }

  const parsed = SkylabResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Skylab API response did not match the expected shape: ${parsed.error.message}`
    );
  }

  return {
    success: parsed.data.success ?? null,
    count: parsed.data.count ?? null,
    stones: parsed.data.data
  };
}

// Fetches the full Skylab stock book, retrying transient failures with exponential
// backoff. Throws (rather than returning empty) once attempts are exhausted — an
// empty return would let the ingest's stale sweep mass-flip every Skylab stone to
// unavailable (Gate §5). Callers treat a throw as a failed run, which alerts and
// leaves the table untouched.
//
// Worst case a full set of attempts costs roughly attempts × SKYLAB_API_TIMEOUT_MS
// plus backoff (~1.5 min at the defaults). That is well inside the scheduler's
// in-flight guard, which simply skips the next tick if a run is still going.
export async function fetchSkylabStock(): Promise<SkylabFetchResult> {
  if (!env.skylabApiKey) {
    throw new Error(
      "SKYLAB_API_KEY is not set — cannot fetch the Skylab API. Set it in the backend env."
    );
  }

  const url = `${env.skylabApiUrl}${env.skylabApiPath}`;
  const maxAttempts = Math.max(1, env.skylabApiRetryAttempts);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchSkylabStockOnce(url);
    } catch (err) {
      const transient = err instanceof TransientSkylabError;
      const message = err instanceof Error ? err.message : String(err);

      if (!transient || attempt >= maxAttempts) {
        // Say how hard we tried — the alert email surfaces this text verbatim, and
        // "after 3 attempts" is the difference between a blip and a real outage.
        throw new Error(attempt > 1 ? `${message} (after ${attempt} attempts)` : message);
      }

      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.warn(
        `[skylab-api] ${message} — retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${maxAttempts})`
      );
      await sleep(delay);
    }
  }
}
