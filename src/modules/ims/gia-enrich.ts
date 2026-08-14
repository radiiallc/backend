
import {
  ImsInboundItemInputSchema,
  type ImsCsvGiaOutcome,
  type ImsGiaPrefill,
  type ImsInboundItemInput,
  type ImsParseInboundCsvResult
} from "@/contract";

import { env } from "../../env";
import { lookupGiaReport } from "./gia.service";

export type GiaLookup = (reportNumber: string) => ReturnType<typeof lookupGiaReport>;

const NON_GIA_LAB = /\b(igi|gcal|bgl|ica|aigs|grs)\b/i;

const FIELD_MAP: ReadonlyArray<[keyof ImsGiaPrefill, string]> = [
  ["naturalOrLab", "naturalOrLab"],
  ["gemType", "gemType"],
  ["shape", "shape"],
  ["weightCt", "weightCt"],
  ["color", "color"],
  ["clarity", "clarity"],
  ["cutGrade", "cutGrade"],
  ["polish", "polish"],
  ["symmetry", "symmetry"],
  ["fluorescence", "fluorescence"],
  ["lengthMm", "lengthMm"],
  ["widthMm", "widthMm"],
  ["heightMm", "heightMm"],
  ["depthPct", "depthPct"],
  ["tablePct", "tablePct"],
  ["girdle", "girdle"],
  ["lab", "lab"],
  ["certNumber", "certNumber"],
  ["origin", "origin"],
  ["treatment", "treatment"]
];

function mergeStone(
  item: ImsInboundItemInput,
  prefill: ImsGiaPrefill
): { item: ImsInboundItemInput; applied: string[] } | null {
  if (item.itemType !== "STONE") return null;
  const stone: Record<string, unknown> = { ...item.stone };
  const applied: string[] = [];
  for (const [key, field] of FIELD_MAP) {
    const value = prefill[key];
    if (value !== null && value !== undefined) {
      stone[field] = value;
      applied.push(field);
    }
  }
  const parsed = ImsInboundItemInputSchema.safeParse({ ...item, stone });
  return parsed.success ? { item: parsed.data, applied } : null;
}

const skip = (message: string, reportNumber: string | null): ImsCsvGiaOutcome => ({
  state: "skipped",
  message,
  reportNumber,
  appliedFields: []
});

async function enrichItem(
  item: ImsInboundItemInput,
  lookup: GiaLookup
): Promise<{ item: ImsInboundItemInput; gia: ImsCsvGiaOutcome | null }> {
  if (item.itemType !== "STONE") return { item, gia: null };

  const cert = item.stone.certNumber ?? null;
  if (!cert) return { item, gia: skip("No Cert No on this row.", null) };

  const lab = item.stone.lab ?? "";
  if (NON_GIA_LAB.test(lab)) {
    return { item, gia: skip(`Lab "${lab}" isn't GIA — GIA enrichment only for now (IGI coming).`, cert) };
  }

  const res = await lookup(cert);

  if (res.found && res.supported && res.prefill) {
    const merged = mergeStone(item, res.prefill);
    if (!merged) {
      return {
        item,
        gia: { state: "error", message: "GIA data didn't fit the stone form; kept the CSV values.", reportNumber: cert, appliedFields: [] }
      };
    }
    return {
      item: merged.item,
      gia: {
        state: "enriched",
        message: `Filled ${merged.applied.length} field${merged.applied.length === 1 ? "" : "s"} from GIA report ${res.reportNumber ?? cert}.`,
        reportNumber: res.reportNumber ?? cert,
        appliedFields: merged.applied
      }
    };
  }

  if (res.found && !res.supported) {
    return { item, gia: skip(res.error ?? "GIA report isn't a gradeable stone.", res.reportNumber ?? cert) };
  }

  return { item, gia: { state: "notFound", message: res.error, reportNumber: cert, appliedFields: [] } };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function enrichInboundCsvWithGia(
  result: ImsParseInboundCsvResult,
  lookup: GiaLookup = lookupGiaReport
): Promise<ImsParseInboundCsvResult> {
  const rows = result.rows.map((r) => ({ ...r }));

  if (!env.giaApiKey) {
    for (const r of rows) {
      if (r.ok && r.item?.itemType === "STONE" && r.item.stone.certNumber) {
        r.gia = {
          state: "notConfigured",
          message: "GIA lookup isn't configured (GIA_API_KEY is unset in the backend env).",
          reportNumber: r.item.stone.certNumber,
          appliedFields: []
        };
      }
    }
    return { ...result, rows };
  }

  const targets = rows.filter((r) => r.ok && r.item);
  const enriched = await mapLimited(targets, 4, (r) => enrichItem(r.item as ImsInboundItemInput, lookup));
  targets.forEach((r, i) => {
    r.item = enriched[i].item;
    r.gia = enriched[i].gia;
  });

  const items = rows.filter((r) => r.ok && r.item).map((r) => r.item as ImsInboundItemInput);
  return { ...result, rows, items };
}
