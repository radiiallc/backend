// GIA Report Results API client (IMS ⑤ — grade-report lookup).
//
// GIA's Report Results API is a single GraphQL endpoint (POST, `Authorization:
// <key>`). One `getReport(report_number)` query returns a GradingReport whose
// `results` is a union keyed by __typename (natural diamond / lab-grown / colored
// stone / pearl / …). The SAME endpoint serves sandbox + production — the key
// scopes which reports are visible — so cutover to live data is a key swap.
//
// Schema confirmed by live introspection against the sandbox (2026-07-23):
//   getReport: GradingReport { report_number, report_date, report_date_iso,
//     report_type, results: ReportResults(union), links: Links, quota }
//   measurements is a STRING ("7.03 - 7.07 x 4.35 mm"); proportions.* are STRINGS.
//   not-found => HTTP 200 with data.getReport=null + errors[].errorInfo.
//
// The key is server-only. This client is the sole outbound path; the admin calls
// our /ims/gia/lookup proxy, never GIA directly.

import { z } from "zod";

import { env } from "../../env";

// One GraphQL query covering the report kinds we map onto a stone item. Fragments
// for other kinds (pearl, jewelry card) simply don't match — `results` then holds
// only __typename and the mapper reports it unsupported. Only fields verified to
// exist via introspection are requested (an unknown field fails the whole query).
const REPORT_QUERY = `query ReportQuery($ReportNumber: String!) {
  getReport(report_number: $ReportNumber) {
    report_number
    report_date
    report_date_iso
    report_type
    results {
      __typename
      ... on DiamondGradingReportResults {
        shape_and_cutting_style
        measurements
        carat_weight
        color_grade
        clarity_grade
        cut_grade
        polish
        symmetry
        fluorescence
        country_of_origin
        proportions { table_pct depth_pct girdle }
      }
      ... on LabGrownDiamondGradingReportResults {
        shape_and_cutting_style
        measurements
        carat_weight
        color_grade
        clarity_grade
        cut_grade
        polish
        symmetry
        fluorescence
        proportions { table_pct depth_pct girdle }
      }
      ... on IdentificationReportResults {
        weight
        measurements
        shape
        cutting_style
        color
        species
        variety
        geographic_origin
        phenomenon
        treatment
      }
    }
    links { pdf image proportions_diagram plotting_diagram }
    quota { remaining }
  }
}`;

// The inline fragments merge into one runtime object, so a single permissive shape
// (every field optional, keyed by which fragment matched) validates all report
// kinds. proportions.* + measurements + carat_weight/weight arrive as strings.
const str = z.string().nullable().optional();

const GiaProportionsSchema = z
  .object({ table_pct: str, depth_pct: str, girdle: str })
  .nullable()
  .optional();

const GiaResultsSchema = z
  .object({
    __typename: z.string().nullable().optional(),
    // Diamond + lab-grown
    shape_and_cutting_style: str,
    measurements: str,
    carat_weight: str,
    color_grade: str,
    clarity_grade: str,
    cut_grade: str,
    polish: str,
    symmetry: str,
    fluorescence: str,
    country_of_origin: str,
    proportions: GiaProportionsSchema,
    // Colored stone (IdentificationReportResults)
    weight: str,
    shape: str,
    cutting_style: str,
    color: str,
    species: str,
    variety: str,
    geographic_origin: str,
    phenomenon: str,
    treatment: str
  })
  .nullable()
  .optional();

const GiaLinksSchema = z
  .object({ pdf: str, image: str, proportions_diagram: str, plotting_diagram: str })
  .nullable()
  .optional();

const GiaReportObjectSchema = z.object({
  report_number: str,
  report_date: str,
  report_date_iso: str,
  report_type: str,
  results: GiaResultsSchema,
  links: GiaLinksSchema,
  quota: z.object({ remaining: z.number().nullable().optional() }).nullable().optional()
});
export type GiaReport = z.infer<typeof GiaReportObjectSchema>;

const GiaResponseSchema = z.object({
  data: z.object({ getReport: GiaReportObjectSchema.nullable() }).nullable().optional(),
  errors: z
    .array(
      z.object({
        errorType: z.string().nullable().optional(),
        errorInfo: z.string().nullable().optional(),
        message: z.string().nullable().optional()
      })
    )
    .nullable()
    .optional()
});

export type GiaErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "QUOTA_REACHED"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "UPSTREAM_ERROR";

export type GiaFetchResult =
  | { ok: true; report: GiaReport }
  | { ok: false; code: GiaErrorCode; message: string };

// Classify a GraphQL `errors[0]` (GIA returns these with HTTP 200) into our code.
function classifyGraphqlError(err: {
  errorType?: string | null;
  errorInfo?: string | null;
  message?: string | null;
}): GiaFetchResult {
  const tag = `${err.errorType ?? ""} ${err.errorInfo ?? ""}`.toUpperCase();
  const message = err.message?.trim() || "GIA could not return this report.";
  if (tag.includes("QUOTA")) {
    return { ok: false, code: "QUOTA_REACHED", message };
  }
  // "REPORT NOT FOUND" / "REPORT UNAVAILABLE" / "IN HOUSE", and a sandbox key
  // hitting a production report ("FORBIDDEN"), all mean "no data for this number".
  return { ok: false, code: "NOT_FOUND", message };
}

// Fetch one GIA report. Never throws — returns a discriminated result the service
// maps to a friendly lookup outcome. An empty key short-circuits to NOT_CONFIGURED
// (no outbound call) so the feature degrades cleanly before GIA is wired.
export async function fetchGiaReport(reportNumber: string): Promise<GiaFetchResult> {
  if (!env.giaApiKey) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "GIA lookup is not configured (GIA_API_KEY is unset in the backend env)."
    };
  }

  let res: Response;
  try {
    res = await fetch(env.giaApiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env.giaApiKey },
      body: JSON.stringify({ query: REPORT_QUERY, variables: { ReportNumber: reportNumber } }),
      signal: AbortSignal.timeout(env.giaApiTimeoutMs)
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "UPSTREAM_ERROR", message: `GIA request failed: ${reason}` };
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "GIA rejected the API key (403). Check GIA_API_KEY."
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      message: "GIA rate limit reached — please try again in a moment."
    };
  }
  if (!res.ok) {
    return { ok: false, code: "UPSTREAM_ERROR", message: `GIA returned HTTP ${res.status}.` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: "UPSTREAM_ERROR", message: "GIA returned a non-JSON response." };
  }

  const parsed = GiaResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: "UPSTREAM_ERROR", message: "GIA response did not match the expected shape." };
  }

  const firstError = parsed.data.errors?.[0];
  if (firstError) {
    return classifyGraphqlError(firstError);
  }

  const report = parsed.data.data?.getReport;
  if (!report) {
    return { ok: false, code: "NOT_FOUND", message: "No GIA report found for that number." };
  }

  return { ok: true, report };
}
