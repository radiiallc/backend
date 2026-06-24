import { env } from "../../env";

// Thin Supabase Storage client over the Storage REST API (no SDK dependency —
// keeps the standalone backend lean, same spirit as the rest of the repo). Used
// for RADIIA-owned inventory media (H3.3). The bucket is PRIVATE: uploads go via
// a short-lived signed upload URL the browser PUTs straight to Supabase; reads
// go via a short-lived signed read URL. The service-role key never leaves the
// server.

const BASE = env.supabaseUrl ? `${env.supabaseUrl}/storage/v1` : "";
const BUCKET = env.supabaseStorageBucket;

export function isStorageConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    apikey: env.supabaseServiceRoleKey
  };
}

export type SignedUpload = {
  // Full URL the browser PUTs the file bytes to (token is embedded as a query param).
  uploadUrl: string;
  // The storage object path we persist on the row (StoneDetail.<slot>).
  path: string;
};

// Ask Supabase for a signed upload URL for `path`. `upsert` lets a re-upload to
// the same slot overwrite. Throws on a non-2xx (caller maps to a 502).
export async function createSignedUploadUrl(path: string): Promise<SignedUpload> {
  const res = await fetch(`${BASE}/object/upload/sign/${BUCKET}/${encodePath(path)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ upsert: true })
  });
  if (!res.ok) throw new Error(`Supabase signed-upload failed (${res.status}): ${await safeText(res)}`);
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("Supabase signed-upload returned no url");
  // data.url is a relative path like "/object/upload/sign/bucket/path?token=…".
  return { uploadUrl: `${BASE}${data.url}`, path };
}

// Short-lived signed read URL for displaying private media.
export async function createSignedReadUrl(path: string, expiresInSec = 3600): Promise<string> {
  const res = await fetch(`${BASE}/object/sign/${BUCKET}/${encodePath(path)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresInSec })
  });
  if (!res.ok) throw new Error(`Supabase sign-read failed (${res.status}): ${await safeText(res)}`);
  const data = (await res.json()) as { signedURL?: string };
  if (!data.signedURL) throw new Error("Supabase sign-read returned no signedURL");
  return `${BASE}${data.signedURL}`;
}

export async function deleteObject(path: string): Promise<void> {
  const res = await fetch(`${BASE}/object/${BUCKET}/${encodePath(path)}`, {
    method: "DELETE",
    headers: authHeaders()
  });
  // Treat a missing object as success (idempotent delete).
  if (!res.ok && res.status !== 404) {
    throw new Error(`Supabase delete failed (${res.status}): ${await safeText(res)}`);
  }
}

// Encode each path segment but keep the slashes that separate folders.
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
