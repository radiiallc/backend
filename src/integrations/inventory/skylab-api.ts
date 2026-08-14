
import { z } from "zod";

import { env } from "../../env";

const numeric = z.union([z.string(), z.number()]).nullable().optional();
const text = z.string().nullable().optional();

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

class TransientSkylabError extends Error {}

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSkylabStockOnce(url: string): Promise<SkylabFetchResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": env.skylabApiKey, accept: "application/json" },
      signal: AbortSignal.timeout(env.skylabApiTimeoutMs)
    });
  } catch (err) {
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
        throw new Error(attempt > 1 ? `${message} (after ${attempt} attempts)` : message);
      }

      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      console.warn(
        `[skylab-api] ${message} — retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${maxAttempts})`
      );
      await sleep(delay);
    }
  }
}
