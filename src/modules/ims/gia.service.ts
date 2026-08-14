
import type { ImsGiaLinks, ImsGiaLookupResult, ImsGiaPrefill, StoneType } from "@/contract";

import { fetchGiaReport, type GiaReport } from "../../integrations/gia/gia-api";

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

function leadingNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseMeasurements(s: string | null | undefined): {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
} {
  const nums = (s?.match(/\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  return { lengthMm: nums[0] ?? null, widthMm: nums[1] ?? null, heightMm: nums[2] ?? null };
}

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
      return { supported: true, naturalOrLab: null };
    default:
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
