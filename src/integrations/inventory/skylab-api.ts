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

// Fetches the full Skylab stock book. Throws (rather than returning empty) on any
// failure — an empty return would let the ingest's stale sweep mass-flip every
// Skylab stone to unavailable (Gate §5). Callers treat a throw as a failed run,
// which alerts and leaves the table untouched.
export async function fetchSkylabStock(): Promise<SkylabFetchResult> {
  if (!env.skylabApiKey) {
    throw new Error(
      "SKYLAB_API_KEY is not set — cannot fetch the Skylab API. Set it in the backend env."
    );
  }

  const url = `${env.skylabApiUrl}${env.skylabApiPath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": env.skylabApiKey, accept: "application/json" },
      signal: AbortSignal.timeout(env.skylabApiTimeoutMs)
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Skylab API request to ${url} failed: ${reason}`);
  }

  if (res.status === 401) {
    throw new Error("Skylab API returned 401 Unauthorized — check SKYLAB_API_KEY.");
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
