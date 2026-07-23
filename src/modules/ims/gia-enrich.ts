/**
 * gia-enrich — optional post-parse pass that fills a stone row's grade fields from
 * its GIA report. Runs only when a bulk import is requested with `enrichGia`. Each
 * STONE row that carries a Cert No is looked up on GIA (concurrency-limited); the
 * report's grade fields OVERWRITE the row's values where GIA supplies one (the cert
 * is authoritative), and the CSV value is kept on any miss. Cost, pricing, quantity,
 * vendor SKU, photos and ratio always stay from the CSV — GIA doesn't carry them.
 *
 * GIA is read-only and the lookup never throws. A missing key degrades every stone
 * row to `notConfigured` with NO outbound call, so this is safe in any environment.
 * The lookup is injected (defaults to the real service) so the merge policy is
 * unit-testable without hitting the network.
 */

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

// Labs whose certs GIA cannot resolve — skip the outbound call (IGI enrichment is
// queued but not built). A blank lab still attempts GIA: a bare cert number on an
// inbound vendor sheet is overwhelmingly a GIA report, and a genuine miss just
// keeps the CSV values.
const NON_GIA_LAB = /\b(igi|gcal|bgl|ica|aigs|grs)\b/i;

// GIA prefill key -> stone detail field. Only these grade fields are taken from the
// report. `fancyColor` is intentionally excluded (the GIA mapper never sets it).
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

// Overwrite a stone item's grade fields with GIA's (where present). Re-validates the
// merged item against the real schema; returns null if the merge somehow breaks it
// (defensive — caller then keeps the original row and flags an error).
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

// Enrich one ok item. Non-stone or cert-less rows are returned untouched with a
// `skipped`/null outcome; a stone with a GIA cert is looked up and merged.
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
    // A real report, but a kind we can't map onto a stone (pearl / jewelry card).
    return { item, gia: skip(res.error ?? "GIA report isn't a gradeable stone.", res.reportNumber ?? cert) };
  }

  return { item, gia: { state: "notFound", message: res.error, reportNumber: cert, appliedFields: [] } };
}

// Run `fn` over items with at most `limit` in flight (GIA is rate-limited; a 60-stone
// Memo In shouldn't fan out to 60 simultaneous calls). Order-preserving.
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

/**
 * Enrich a parse result in place-of-return: fills stone rows from GIA and attaches a
 * per-row `gia` outcome, keeping `rows[*].item` and the flat `items` array in sync so
 * the confirmed inbound POST carries the enriched values. Only ok rows are touched.
 */
export async function enrichInboundCsvWithGia(
  result: ImsParseInboundCsvResult,
  lookup: GiaLookup = lookupGiaReport
): Promise<ImsParseInboundCsvResult> {
  const rows = result.rows.map((r) => ({ ...r }));

  // No key configured → mark every cert-bearing stone row notConfigured, no calls.
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
