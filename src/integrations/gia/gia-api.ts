
import { z } from "zod";

import { env } from "../../env";

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

const str = z.string().nullable().optional();

const GiaProportionsSchema = z
  .object({ table_pct: str, depth_pct: str, girdle: str })
  .nullable()
  .optional();

const GiaResultsSchema = z
  .object({
    __typename: z.string().nullable().optional(),
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
  return { ok: false, code: "NOT_FOUND", message };
}

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
