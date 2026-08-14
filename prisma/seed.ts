import { hash } from "@node-rs/argon2";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";

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
  await prisma.user.upsert({
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

  await prisma.vendor.upsert({
    where: { name: "Demo Vendor" },
    update: {},
    create: {
      name: "Demo Vendor",
      contactName: "Dev Contact",
      contactEmail: "vendor@demo-vendors.example",
      defaultMemoTermsDays: 7,
      defaultInvoiceTermsDays: 30,
      notes: "Seed vendor for local development — inbound documents / CSV import."
    }
  });

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
