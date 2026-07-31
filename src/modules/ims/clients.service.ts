import { Prisma, prisma } from "@/db";
import type {
  ClientLifecycleAction,
  ClientStatus,
  ImsClient,
  ImsCreateClient,
  ImsUpdateClient
} from "@/contract";

import { IMS_CLIENT_INCLUDE, prismaClientToDto } from "./mappers";

export type ClientMutationResult =
  | { ok: true; client: ImsClient }
  | { ok: false; error: string };

async function loadClientDto(id: string): Promise<ImsClient> {
  const c = await prisma.company.findUniqueOrThrow({ where: { id }, include: IMS_CLIENT_INCLUDE });
  return prismaClientToDto(c);
}

// Mirrors the admin's clientMarkupsSet: a portal signup lands with all three
// markups at 0, and approval is blocked until staff set them (else the portal
// would price at cost). All three must be > 0.
function markupsSet(c: {
  gemstoneMarkupPct: Prisma.Decimal;
  labDiamondMarkupPct: Prisma.Decimal;
  naturalDiamondMarkupPct: Prisma.Decimal;
}): boolean {
  return (
    Number(c.gemstoneMarkupPct.toString()) > 0 &&
    Number(c.labDiamondMarkupPct.toString()) > 0 &&
    Number(c.naturalDiamondMarkupPct.toString()) > 0
  );
}

// Manually add a back-office client (admin "New client"). A staff-added account
// lands ACTIVE — portal self-signups take the portal auth path and land PENDING,
// then run through the lifecycle below. Only name is required; the rest use
// schema defaults when omitted.
export async function createClient(input: ImsCreateClient): Promise<ClientMutationResult> {
  const created = await prisma.company.create({
    data: {
      name: input.name,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      website: input.website ?? null,
      shippingAddress: input.shippingAddress ?? null,
      internalNotes: input.internalNotes ?? "",
      creditLimitUsd: input.creditLimitUsd ?? 0,
      gemstoneMarkupPct: input.gemstoneMarkupPct ?? 0,
      labDiamondMarkupPct: input.labDiamondMarkupPct ?? 0,
      naturalDiamondMarkupPct: input.naturalDiamondMarkupPct ?? 0,
      defaultMemoTermsDays: input.defaultMemoTermsDays ?? null,
      defaultInvoiceTermsDays: input.defaultInvoiceTermsDays ?? null,
      quickbooksId: input.quickbooksId ?? null,
      clientStatus: "ACTIVE"
    },
    include: IMS_CLIENT_INCLUDE
  });
  return { ok: true, client: prismaClientToDto(created) };
}

// Patch a client's account fields + the staff internalNotes. clientStatus is not
// touched here — approval moves only through transitionClientStatus. An absent
// key is left unchanged; an explicit null clears a nullable field.
export async function updateClient(
  id: string,
  input: ImsUpdateClient
): Promise<ClientMutationResult> {
  const existing = await prisma.company.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, error: "Client not found" };

  const data: Prisma.CompanyUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.contactName !== undefined) data.contactName = input.contactName;
  if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail;
  if (input.contactPhone !== undefined) data.contactPhone = input.contactPhone;
  if (input.website !== undefined) data.website = input.website;
  if (input.shippingAddress !== undefined) data.shippingAddress = input.shippingAddress;
  if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;
  if (input.creditLimitUsd !== undefined) data.creditLimitUsd = input.creditLimitUsd;
  if (input.gemstoneMarkupPct !== undefined) data.gemstoneMarkupPct = input.gemstoneMarkupPct;
  if (input.labDiamondMarkupPct !== undefined) data.labDiamondMarkupPct = input.labDiamondMarkupPct;
  if (input.naturalDiamondMarkupPct !== undefined)
    data.naturalDiamondMarkupPct = input.naturalDiamondMarkupPct;
  if (input.defaultMemoTermsDays !== undefined)
    data.defaultMemoTermsDays = input.defaultMemoTermsDays;
  if (input.defaultInvoiceTermsDays !== undefined)
    data.defaultInvoiceTermsDays = input.defaultInvoiceTermsDays;
  if (input.quickbooksId !== undefined) data.quickbooksId = input.quickbooksId;

  await prisma.company.update({ where: { id }, data });
  return { ok: true, client: await loadClientDto(id) };
}

// The allowed lifecycle moves (admin #0045). Each verb names both its legal
// source state(s) and its destination — the API is the source of truth, so an
// out-of-state call is rejected rather than relying on the UI to gate it.
const TRANSITIONS: Record<ClientLifecycleAction, { from: ClientStatus[]; to: ClientStatus }> = {
  approve: { from: ["PENDING"], to: "ACTIVE" },
  decline: { from: ["PENDING"], to: "DECLINED" },
  deactivate: { from: ["ACTIVE"], to: "DEACTIVATED" },
  reactivate: { from: ["DEACTIVATED"], to: "ACTIVE" }
};

// Move a client through its approval lifecycle. Validates the (current → action)
// pair, and — for approve only — requires the portal markups to be set first.
export async function transitionClientStatus(
  id: string,
  action: ClientLifecycleAction
): Promise<ClientMutationResult> {
  const c = await prisma.company.findUnique({
    where: { id },
    select: {
      clientStatus: true,
      gemstoneMarkupPct: true,
      labDiamondMarkupPct: true,
      naturalDiamondMarkupPct: true
    }
  });
  if (!c) return { ok: false, error: "Client not found" };

  const rule = TRANSITIONS[action];
  if (!rule.from.includes(c.clientStatus)) {
    return { ok: false, error: `Cannot ${action} a ${c.clientStatus.toLowerCase()} client` };
  }
  if (action === "approve" && !markupsSet(c)) {
    return { ok: false, error: "Set portal markups before approving — edit the client first" };
  }

  await prisma.company.update({ where: { id }, data: { clientStatus: rule.to } });
  return { ok: true, client: await loadClientDto(id) };
}
