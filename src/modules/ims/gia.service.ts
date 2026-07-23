// GIA lookup service (IMS ⑤). Fetches a GIA report via the integration client and
// normalizes it into the admin-facing `ImsGiaLookupResult` — a mergeable pre-fill
// for the stone item form plus the transient GIA asset links. Always resolves to a
// result (never throws): fetch failures become `found:false` + a friendly `error`,
// so the admin proxy can return one consistent 200 shape.

import type { ImsGiaLinks, ImsGiaLookupResult, ImsGiaPrefill, StoneType } from "@/contract";

import { fetchGiaReport, type GiaReport } from "../../integrations/gia/gia-api";

// GIA returns human phrases where a field wasn't requested/determined; those aren't
// real values for our form, so blank them out.
const PLACEHOLDERS = new Set([
  "not requested",
  "not determined",
  "not applicable",
  "undetermined",
  "none requested",
  "n/a"
]);

function txt(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t || null;
}

function meaningful(s: string | null | undefined): string | null {
  const t = txt(s);
  return t && !PLACEHOLDERS.has(t.toLowerCase()) ? t : null;
}

// "1.32 carat" -> 1.32, "5.66 carats" -> 5.66, "58" -> 58, "61.7" -> 61.7.
function leadingNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// GIA measurements are one string: round = "min - max x depth mm", fancy =
// "L x W x H mm". Both yield three numbers in order → length, width, height.
function parseMeasurements(s: string | null | undefined): {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
} {
  const nums = (s?.match(/\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  return { lengthMm: nums[0] ?? null, widthMm: nums[1] ?? null, heightMm: nums[2] ?? null };
}

// Result __typename -> (is it a stone we can pre-fill, and natural/lab if a diamond).
function classifyResults(typename: string | null | undefined): {
  supported: boolean;
  naturalOrLab: StoneType | null;
} {
  switch (typename) {
    case "DiamondGradingReportResults":
      return { supported: true, naturalOrLab: "NATURAL" };
    case "LabGrownDiamondGradingReportResults":
      return { supported: true, naturalOrLab: "LAB" };
    case "IdentificationReportResults":
      // Colored stone / gemstone — a stone we can pre-fill, but not a graded diamond.
      return { supported: true, naturalOrLab: null };
    default:
      // Pearl, jewelry card, melee, etc. — nothing to map onto a stone item.
      return { supported: false, naturalOrLab: null };
  }
}

function buildLinks(report: GiaReport): ImsGiaLinks {
  const l = report.links ?? {};
  return {
    pdf: txt(l.pdf),
    image: txt(l.image),
    proportionsDiagram: txt(l.proportions_diagram),
    plottingDiagram: txt(l.plotting_diagram)
  };
}

function buildPrefill(report: GiaReport, naturalOrLab: StoneType | null): ImsGiaPrefill {
  const r = report.results ?? {};
  const dims = parseMeasurements(r.measurements);
  return {
    naturalOrLab,
    // Diamond reports (NATURAL/LAB) → "Diamond"; a colored stone carries its
    // variety ("Emerald") or, failing that, species ("Natural Beryl").
    gemType: naturalOrLab ? "Diamond" : (txt(r.variety) ?? txt(r.species)),
    shape: txt(r.shape_and_cutting_style) ?? txt(r.shape),
    weightCt: leadingNumber(r.carat_weight) ?? leadingNumber(r.weight),
    color: txt(r.color_grade) ?? txt(r.color),
    fancyColor: null,
    clarity: txt(r.clarity_grade),
    cutGrade: txt(r.cut_grade),
    polish: txt(r.polish),
    symmetry: txt(r.symmetry),
    fluorescence: txt(r.fluorescence),
    lengthMm: dims.lengthMm,
    widthMm: dims.widthMm,
    heightMm: dims.heightMm,
    depthPct: leadingNumber(r.proportions?.depth_pct),
    tablePct: leadingNumber(r.proportions?.table_pct),
    girdle: txt(r.proportions?.girdle),
    lab: "GIA",
    certNumber: txt(report.report_number),
    origin: meaningful(r.country_of_origin) ?? meaningful(r.geographic_origin),
    treatment: meaningful(r.treatment)
  };
}

// A failure from the client → a not-found-shaped result carrying the reason.
function failure(reportNumber: string, error: string): ImsGiaLookupResult {
  return {
    found: false,
    supported: false,
    reportNumber,
    reportDate: null,
    reportType: null,
    resultType: null,
    prefill: null,
    links: null,
    quotaRemaining: null,
    error
  };
}

export async function lookupGiaReport(reportNumber: string): Promise<ImsGiaLookupResult> {
  const fetched = await fetchGiaReport(reportNumber);
  if (!fetched.ok) {
    return failure(reportNumber, fetched.message);
  }

  const report = fetched.report;
  const resultType = txt(report.results?.__typename);
  const { supported, naturalOrLab } = classifyResults(resultType);
  const links = buildLinks(report);
  const quotaRemaining = report.quota?.remaining ?? null;
  const reportDate = txt(report.report_date_iso) ?? txt(report.report_date);

  if (!supported) {
    // GIA found the report, but it isn't a diamond/gemstone we can pre-fill. Still
    // hand back the PDF link so the admin can view it and enter the item manually.
    return {
      found: true,
      supported: false,
      reportNumber: txt(report.report_number) ?? reportNumber,
      reportDate,
      reportType: txt(report.report_type),
      resultType,
      prefill: null,
      links,
      quotaRemaining,
      error: `GIA report ${txt(report.report_number) ?? reportNumber} is ${
        txt(report.report_type) ?? "not a diamond or gemstone report"
      } — its fields don't map to a stone. Enter the item manually.`
    };
  }

  return {
    found: true,
    supported: true,
    reportNumber: txt(report.report_number) ?? reportNumber,
    reportDate,
    reportType: txt(report.report_type),
    resultType,
    prefill: buildPrefill(report, naturalOrLab),
    links,
    quotaRemaining,
    error: null
  };
}
