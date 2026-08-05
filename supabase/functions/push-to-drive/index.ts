// push-to-drive — routes classified documents into each client's Google
// Drive folder, in a subfolder per document type, using a Google service
// account (JWT bearer OAuth flow — no external deps needed in Deno).
//
// Requires an app_secrets row "google_service_account_json" holding the full
// service-account JSON key (client_email + private_key), and each client's
// Drive folder (clients.drive_folder_id) must be shared with that service
// account's email as an Editor. Until that secret exists, this function
// returns a clear error and touches nothing.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BATCH_LIMIT = 20;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function pemToDer(pem: string): ArrayBuffer {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(saJson: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: saJson.client_email,
    scope: DRIVE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(utf8(JSON.stringify(header)))}.${b64url(utf8(JSON.stringify(claims)))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(saJson.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`google oauth token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function findOrCreateSubfolder(token: string, parentId: string, name: string, cache: Map<string, string>): Promise<string> {
  const cacheKey = `${parentId}/${name}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) throw new Error(`drive folder search: ${listRes.status} ${await listRes.text()}`);
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) {
    cache.set(cacheKey, listData.files[0].id);
    return listData.files[0].id;
  }

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!createRes.ok) throw new Error(`drive folder create: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json();
  cache.set(cacheKey, created.id);
  return created.id;
}

async function uploadFile(token: string, parentId: string, name: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const boundary = "wwc-binder-" + crypto.randomUUID();
  const metadata = JSON.stringify({ name, parents: [parentId] });

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.length; }

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`drive upload: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: secretRows } = await admin.from("app_secrets").select("key,value").in("key", ["google_service_account_json"]);
  const saRaw = (secretRows || []).find((r: any) => r.key === "google_service_account_json")?.value;
  if (!saRaw) return json({ error: "google_service_account_json not set in app_secrets" }, 500);

  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(saRaw);
    if (!sa.client_email || !sa.private_key) throw new Error("missing client_email/private_key");
  } catch (e) {
    return json({ error: `google_service_account_json is not valid: ${(e as Error).message}` }, 500);
  }

  const { data: pending, error: qErr } = await admin
    .from("client_documents")
    .select(`
      id, client_slug, renamed_filename, submission_id, classification_notes,
      document_types ( label ),
      submissions ( file_path, content_type ),
      clients ( drive_folder_id )
    `)
    .eq("status", "classified")
    .is("drive_file_id", null)
    .limit(BATCH_LIMIT);
  if (qErr) return json({ error: qErr.message }, 500);

  if (!pending || pending.length === 0) return json({ processed: 0, results: [] });

  let token: string;
  try {
    token = await getAccessToken(sa);
  } catch (e) {
    return json({ error: `could not get Google access token: ${(e as Error).message}` }, 500);
  }

  const folderCache = new Map<string, string>();
  const results: Record<string, unknown>[] = [];

  for (const doc of pending as any[]) {
    try {
      const clientFolderId = doc.clients?.drive_folder_id;
      if (!clientFolderId) throw new Error("client has no drive_folder_id set");
      const filePath = doc.submissions?.file_path;
      if (!filePath) throw new Error("underlying submission/file not found");

      const { data: blob, error: dlErr } = await admin.storage.from("client-docs").download(filePath);
      if (dlErr) throw new Error(`download: ${dlErr.message}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const label = doc.document_types?.label || "Other";
      const subfolderId = await findOrCreateSubfolder(token, clientFolderId, label, folderCache);
      const mimeType = doc.submissions?.content_type || "application/octet-stream";
      const driveFileId = await uploadFile(token, subfolderId, doc.renamed_filename || filePath, mimeType, bytes);

      await admin.from("client_documents").update({ drive_file_id: driveFileId, status: "pushed_to_drive" }).eq("id", doc.id);
      results.push({ id: doc.id, status: "pushed_to_drive", drive_file_id: driveFileId });
    } catch (e) {
      const message = String((e as Error).message || e);
      const combinedNotes = [doc.classification_notes, `Drive push failed: ${message}`].filter(Boolean).join(" | ");
      await admin.from("client_documents").update({
        status: "error",
        classification_notes: combinedNotes,
      }).eq("id", doc.id);
      results.push({ id: doc.id, status: "error", error: message });
    }
  }

  return json({ processed: results.length, results });
});
