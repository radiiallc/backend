import { prisma } from "@/db";

// Resolves the vendor "second image" (gem-on-hand) URL for a gemstone. Server-only:
// these images are hosted on the vendor's own host, so — like certUrl (Gate §8) —
// the URL is fetched + streamed by the route and never returned to any caller.
export async function resolveGemstoneImage2Url(id: string): Promise<string | null> {
  const g = await prisma.gemstone.findUnique({
    where: { id },
    select: { image2Url: true }
  });
  return g?.image2Url ?? null;
}
