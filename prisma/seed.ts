import { hash } from "@node-rs/argon2";
import {
  CertLab,
  ItemStatus,
  ItemSubtype,
  ItemType,
  PrismaClient,
  StoneType,
  UserRole,
  UserStatus
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { id: "seed-demo-company" },
    update: {},
    create: {
      id: "seed-demo-company",
      name: "Demo Buyers Inc.",
      contactEmail: "contact@demo-buyers.example",
      shippingAddress: "Demo Buyers Inc.\n100 Demo Street\nNew York, NY 10001\nUnited States",
      internalNotes: "Seed company for local development.",
      gemstoneMarkupPct: "25.00"
    }
  });

  const adminPassword = await hash("radiia-admin-dev", {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
  await prisma.user.upsert({
    where: { email: "admin@radiia.local" },
    update: {},
    create: {
      email: "admin@radiia.local",
      passwordHash: adminPassword,
      fullName: "Jennifer (admin dev)",
      role: UserRole.ADMIN,
      status: UserStatus.APPROVED
    }
  });

  const buyerPassword = await hash("radiia-buyer-dev", {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
  const buyer = await prisma.user.upsert({
    where: { email: "buyer@demo-buyers.example" },
    update: {},
    create: {
      email: "buyer@demo-buyers.example",
      passwordHash: buyerPassword,
      fullName: "Demo Buyer",
      location: "New York, NY",
      role: UserRole.BUYER,
      status: UserStatus.APPROVED,
      approvedAt: new Date(),
      companyId: company.id
    }
  });

  // A STAFF user (new role added in H1.1) for exercising the H2 admin/staff gate.
  const staffPassword = await hash("radiia-staff-dev", {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
  await prisma.user.upsert({
    where: { email: "staff@radiia.local" },
    update: {},
    create: {
      email: "staff@radiia.local",
      passwordHash: staffPassword,
      fullName: "Demo Staff",
      role: UserRole.STAFF,
      status: UserStatus.APPROVED,
      approvedAt: new Date()
    }
  });

  // ── IMS seed (H1.6): 1 vendor, 1 client + linked portal user, sample stones ──

  const vendor = await prisma.vendor.upsert({
    where: { id: "seed-demo-vendor" },
    update: {},
    create: {
      id: "seed-demo-vendor",
      name: "Demo Gem Vendor LLC",
      contactName: "Vendor Contact",
      contactEmail: "sales@demo-vendor.example",
      defaultMemoTermsDays: 30,
      notes: "Seed vendor for local development."
    }
  });

  const client = await prisma.client.upsert({
    where: { id: "seed-demo-client" },
    update: {},
    create: {
      id: "seed-demo-client",
      name: "Demo Buyers Inc.",
      contactName: "Demo Buyer",
      contactEmail: "contact@demo-buyers.example",
      defaultTermsDays: 30,
      creditLimit: "50000.00",
      notes: "Seed client (maps onto the demo buyer Company — D4)."
    }
  });

  // Link the existing demo buyer (portal user) to the client.
  await prisma.clientUser.upsert({
    where: { clientId_userId: { clientId: client.id, userId: buyer.id } },
    update: {},
    create: { clientId: client.id, userId: buyer.id, role: "primary" }
  });

  // computeDerived() lands in H3; inline the same math here so seeded rows are realistic.
  const round = (n: number) => Math.round(n * 100) / 100;
  type StoneSeed = {
    id: string;
    sku: string;
    subtype: ItemSubtype;
    qty: number; // 1 for SINGLE/PAIR; parcel count for PARCEL
    visibleOnPortal: boolean;
    stone: {
      gemType?: string;
      shape: string;
      weightCt: number;
      color?: string;
      clarity?: string;
      cutGrade?: string;
      lengthMm?: number;
      widthMm?: number;
      heightMm?: number;
      lab: CertLab;
      certNumber?: string;
      naturalOrLab?: StoneType;
      origin?: string;
      treatment?: string;
      wholesalePricePerCt: number;
      costPerCt: number;
    };
  };

  const stones: StoneSeed[] = [
    {
      id: "seed-stone-single",
      sku: "RAD-00001",
      subtype: ItemSubtype.SINGLE,
      qty: 1,
      visibleOnPortal: true,
      stone: {
        shape: "Round",
        weightCt: 1.01,
        color: "F",
        clarity: "VS1",
        cutGrade: "Excellent",
        lengthMm: 6.45,
        widthMm: 6.48,
        heightMm: 3.99,
        lab: CertLab.GIA,
        certNumber: "2185749632",
        naturalOrLab: StoneType.NATURAL,
        wholesalePricePerCt: 6800,
        costPerCt: 5200
      }
    },
    {
      id: "seed-stone-pair",
      sku: "RAD-00002",
      subtype: ItemSubtype.PAIR,
      qty: 1,
      visibleOnPortal: true,
      stone: {
        gemType: "Sapphire",
        shape: "Oval",
        weightCt: 4.12, // total carat for the matched pair
        color: "Blue",
        lengthMm: 9.1,
        widthMm: 7.0,
        lab: CertLab.NONE,
        origin: "Sri Lanka",
        treatment: "Heated",
        wholesalePricePerCt: 1500,
        costPerCt: 1100
      }
    },
    {
      id: "seed-stone-parcel",
      sku: "RAD-00003",
      subtype: ItemSubtype.PARCEL,
      qty: 50,
      visibleOnPortal: false,
      stone: {
        gemType: "Diamond",
        shape: "Round",
        weightCt: 5.0, // total parcel carat
        color: "G-H",
        clarity: "SI",
        lab: CertLab.NONE,
        naturalOrLab: StoneType.NATURAL,
        wholesalePricePerCt: 900,
        costPerCt: 650
      }
    }
  ];

  for (const s of stones) {
    const ratio =
      s.stone.lengthMm && s.stone.widthMm ? round(s.stone.lengthMm / s.stone.widthMm) : null;
    const totalWholesale = round(s.stone.weightCt * s.stone.wholesalePricePerCt);
    const totalCost = round(s.stone.weightCt * s.stone.costPerCt);

    await prisma.inventoryItem.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        sku: s.sku,
        itemType: ItemType.STONE,
        itemSubtype: s.subtype,
        status: ItemStatus.IN_STOCK,
        vendorId: vendor.id,
        visibleOnPortal: s.visibleOnPortal,
        stoneDetail: {
          create: {
            gemType: s.stone.gemType ?? null,
            shape: s.stone.shape,
            weightCt: s.stone.weightCt.toString(),
            quantity: s.subtype === ItemSubtype.PARCEL ? s.qty : null,
            color: s.stone.color ?? null,
            clarity: s.stone.clarity ?? null,
            cutGrade: s.stone.cutGrade ?? null,
            lengthMm: s.stone.lengthMm?.toString() ?? null,
            widthMm: s.stone.widthMm?.toString() ?? null,
            heightMm: s.stone.heightMm?.toString() ?? null,
            ratio: ratio?.toString() ?? null,
            lab: s.stone.lab,
            certNumber: s.stone.certNumber ?? null,
            naturalOrLab: s.stone.naturalOrLab ?? null,
            origin: s.stone.origin ?? null,
            treatment: s.stone.treatment ?? null,
            wholesalePricePerCt: s.stone.wholesalePricePerCt.toString(),
            costPerCt: s.stone.costPerCt.toString(),
            totalWholesalePrice: totalWholesale.toString(),
            totalCost: totalCost.toString()
          }
        },
        statusHistory: {
          create: {
            previousStatus: null,
            newStatus: ItemStatus.IN_STOCK,
            changedById: buyer.id, // placeholder actor; real flows use the acting admin/staff
            notes: "Seed: initial stock entry."
          }
        }
      }
    });
  }

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
