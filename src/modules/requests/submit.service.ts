import { Prisma, prisma } from "@/db";
import { formatRequestReference, gemstoneVarietyAbbrev } from "@/domain";
import {
  SubmitRequestBodySchema,
  type SubmitRequestInput,
  type SubmitRequestResult
} from "@/contract";

import {
  sendRequestSubmittedAdminNotification,
  sendRequestSubmittedConfirmation,
  type SubmittedRequestItem
} from "../../integrations/email";

export async function submitRequest(
  userId: string,
  input: SubmitRequestInput
): Promise<SubmitRequestResult> {
  const parsed = SubmitRequestBodySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { type, note, cartItemIds } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, fullName: true, companyId: true }
  });
  if (!user) return { ok: false, error: "Account not found" };
  if (!user.companyId) {
    return { ok: false, error: "Your account is not linked to a company yet" };
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const cart = await tx.cart.findUnique({
          where: { userId },
          include: {
            items: { include: { gemstone: true, diamond: true } }
          }
        });
        if (!cart || cart.items.length === 0) {
          return { kind: "empty" as const };
        }

        const selectedIdSet = new Set(cartItemIds);
        const selectedItems = cart.items.filter((ci) => selectedIdSet.has(ci.id));
        if (selectedItems.length === 0) {
          return { kind: "none-selected" as const };
        }

        const unavailable = selectedItems.find(
          (ci) =>
            (ci.gemstone && !ci.gemstone.isAvailable) ||
            (ci.diamond && !ci.diamond.isAvailable)
        );
        if (unavailable) {
          return {
            kind: "unavailable" as const,
            sku: unavailable.gemstone?.sku ?? unavailable.diamond?.sku ?? "item"
          };
        }

        const company = await tx.company.findUnique({
          where: { id: user.companyId! },
          select: {
            id: true,
            name: true,
            gemstoneMarkupPct: true,
            labDiamondMarkupPct: true,
            naturalDiamondMarkupPct: true
          }
        });
        if (!company) return { kind: "no-company" as const };

        const gemMarkupPct = Number(company.gemstoneMarkupPct ?? 0);
        const labMarkupPct = Number(company.labDiamondMarkupPct ?? 0);
        const naturalMarkupPct = Number(company.naturalDiamondMarkupPct ?? 0);
        const gemFactor = 1 + (Number.isFinite(gemMarkupPct) ? gemMarkupPct : 0) / 100;
        const labFactor = 1 + (Number.isFinite(labMarkupPct) ? labMarkupPct : 0) / 100;
        const naturalFactor =
          1 + (Number.isFinite(naturalMarkupPct) ? naturalMarkupPct : 0) / 100;

        const request = await tx.request.create({
          data: {
            type,
            status: "PENDING",
            userId,
            companyId: company.id,
            note
          }
        });

        const summaryItems: SubmittedRequestItem[] = [];
        const requestItemRows: Prisma.RequestItemCreateManyInput[] = [];
        let totalUsd = 0;

        for (const ci of selectedItems) {
          const qty = 1;
          if (ci.gemstone) {
            const gem = ci.gemstone;
            const basePriceUsd = gem.basePriceUsd === null ? null : Number(gem.basePriceUsd);
            const basePricePerCtUsd =
              gem.basePricePerCtUsd === null ? null : Number(gem.basePricePerCtUsd);
            const displayPricePerCtUsd =
              basePricePerCtUsd === null ? null : Math.round(basePricePerCtUsd * gemFactor * 100) / 100;
            const unitPrice =
              basePriceUsd === null ? 0 : Math.round(basePriceUsd * gemFactor * 100) / 100;
            const lineTotal = Math.round(unitPrice * qty * 100) / 100;
            totalUsd += lineTotal;

            requestItemRows.push({
              requestId: request.id,
              gemstoneId: gem.id,
              snapshotSku: gem.sku,
              snapshotPriceUsd: lineTotal,
              status: "PENDING",
              snapshotPayload: {
                category: "gemstone",
                vendor: "RADIIA",
                markupPct: gemMarkupPct,
                qty,
                gemstoneId: gem.id,
                sku: gem.sku,
                varietyRaw: gem.varietyRaw,
                shapeRaw: gem.shapeRaw,
                colorRaw: gem.colorRaw,
                weightCt: gem.weightCt === null ? null : Number(gem.weightCt),
                basePriceUsd,
                basePricePerCtUsd,
                displayPricePerCtUsd,
                unitDisplayPriceUsd: unitPrice,
                certLab: gem.certLab,
                certNumber: gem.certNumber,
                origin: gem.origin,
                treatment: gem.treatment
              }
            });

            summaryItems.push({
              sku: gem.sku,
              varietyOrName: gem.varietyRaw ?? gem.sku,
              stoneType: gemstoneVarietyAbbrev(gem.varietyRaw) ?? "GEM",
              color: null,
              clarity: null,
              shape: gem.shapeRaw,
              weightCt: gem.weightCt === null ? null : Number(gem.weightCt),
              totalPriceUsd: lineTotal
            });
          } else if (ci.diamond) {
            const dia = ci.diamond;
            const isLab = dia.origin === "Lab";
            const factor = isLab ? labFactor : naturalFactor;
            const markupPct = isLab ? labMarkupPct : naturalMarkupPct;
            const basePriceUsd = dia.basePriceUsd === null ? null : Number(dia.basePriceUsd);
            const basePricePerCtUsd =
              dia.basePricePerCtUsd === null ? null : Number(dia.basePricePerCtUsd);
            const displayPricePerCtUsd =
              basePricePerCtUsd === null ? null : Math.round(basePricePerCtUsd * factor * 100) / 100;
            const unitPrice =
              basePriceUsd === null ? 0 : Math.round(basePriceUsd * factor * 100) / 100;
            const lineTotal = Math.round(unitPrice * qty * 100) / 100;
            totalUsd += lineTotal;
            const variety = isLab ? "Lab Diamond" : "Natural Diamond";

            requestItemRows.push({
              requestId: request.id,
              gemstoneId: null,
              snapshotSku: dia.sku,
              snapshotPriceUsd: lineTotal,
              status: "PENDING",
              snapshotPayload: {
                category: "diamond",
                vendor: dia.vendor,
                markupPct,
                qty,
                diamondId: dia.id,
                sku: dia.sku,
                varietyRaw: variety,
                shapeRaw: dia.shapeRaw,
                shapeMapped: dia.shapeMapped,
                colorRaw: dia.fancyColor ?? dia.colorWhite,
                clarity: dia.clarity,
                weightCt: dia.weightCt === null ? null : Number(dia.weightCt),
                basePriceUsd,
                basePricePerCtUsd,
                displayPricePerCtUsd,
                unitDisplayPriceUsd: unitPrice,
                certLab: dia.certLab,
                certNumber: dia.certNumber,
                origin: dia.origin,
                treatment: dia.treatment
              }
            });

            summaryItems.push({
              sku: dia.sku,
              varietyOrName: variety,
              stoneType: isLab ? "Lab" : "Nat",
              color: dia.fancyColor ?? dia.colorWhite,
              clarity: dia.clarity,
              shape: dia.shapeMapped ?? dia.shapeRaw,
              weightCt: dia.weightCt === null ? null : Number(dia.weightCt),
              totalPriceUsd: lineTotal
            });
          }
        }

        if (requestItemRows.length > 0) {
          await tx.requestItem.createMany({ data: requestItemRows });
        }

        await tx.cartItem.deleteMany({
          where: { cartId: cart.id, id: { in: selectedItems.map((ci) => ci.id) } }
        });

        return {
          kind: "ok" as const,
          requestId: request.id,
          requestSeq: request.seq,
          companyName: company.name,
          items: summaryItems,
          totalUsd: Math.round(totalUsd * 100) / 100
        };
      },
      { maxWait: 15000, timeout: 30000 }
    );

    if (result.kind === "empty") {
      return { ok: false, error: "Your cart is empty" };
    }
    if (result.kind === "none-selected") {
      return { ok: false, error: "Select at least one item to submit." };
    }
    if (result.kind === "unavailable") {
      return {
        ok: false,
        error: `Item ${result.sku} is no longer available. Remove it before submitting.`
      };
    }
    if (result.kind === "no-company") {
      return { ok: false, error: "Your account is not linked to a company yet" };
    }

    const reference = formatRequestReference(result.requestSeq);
    const failures: string[] = [];
    try {
      const firstName = user.fullName.trim().split(/\s+/)[0] ?? user.fullName;
      await sendRequestSubmittedConfirmation({
        email: user.email,
        firstName,
        reference,
        requestId: result.requestId,
        type,
        items: result.items,
        totalUsd: result.totalUsd,
        note
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      console.error("[submitRequest] buyer confirmation email failed", err);
      failures.push(`buyer confirmation to ${user.email} (${detail})`);
    }
    try {
      await sendRequestSubmittedAdminNotification({
        buyerEmail: user.email,
        buyerName: user.fullName,
        companyName: result.companyName,
        reference,
        type,
        items: result.items,
        totalUsd: result.totalUsd,
        note
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      console.error("[submitRequest] admin notification email failed", err);
      failures.push(`admin notification (${detail})`);
    }

    if (failures.length > 0) {
      return {
        ok: true,
        requestId: result.requestId,
        reference,
        warning:
          `Your request was submitted, but the following email(s) could not be sent: ` +
          `${failures.join("; ")}. The RADIIA team has your request and will follow up.`
      };
    }
    return { ok: true, requestId: result.requestId, reference };
  } catch (err) {
    console.error("[submitRequest] failed", err);
    return {
      ok: false,
      error: "Something went wrong submitting your request. Please try again."
    };
  }
}
