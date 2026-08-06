// push-to-drive — routes classified documents into each client's Google
// Drive folder, in a subfolder per document type, using a standard OAuth
// refresh-token flow (Google Cloud org policy blocks service-account key
// creation, so we authenticate as a real Google account instead).
//
// Requires an app_secrets row "google_oauth_credentials" holding
// {"client_id": "...", "client_secret": "...", "refresh_token": "..."} for
// a Google account that already has access to (or owns) each client's Drive
// folder referenced by clients.drive_folder_id. Until that secret exists,
// this function returns a clear error and touches nothing.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BATCH_LIMIT = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

// Only pg_cron (bearing the service role key) or the single authorized admin
// (via the dashboard's "run now" button) may invoke this — otherwise anyone
// who signs up through the public magic-link flow could trigger Drive uploads.
async function checkAuth(req: Request, admin: ReturnType<typeof createClient>): Promise<Response | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);
  if (token === SERVICE_ROLE) return null;

  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user?.email) return json({ error: "unauthorized" }, 401);

  const { data: row } = await admin.from("app_secrets").select("value").eq("key", "admin_email").maybeSingle();
  const adminEmail = row?.value as string | undefined;
  if (!adminEmail || ud.user.email.toLowerCase() !== adminEmail.toLowerCase()) return json({ error: "forbidden" }, 403);
  return null;
}

interface GoogleOAuthCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

async function getAccessToken(creds: GoogleOAuthCreds): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google oauth refresh: ${res.status} ${await res.text()}`);
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

  const authErr = await checkAuth(req, admin);
  if (authErr) return authErr;

  const { data: secretRows } = await admin.from("app_secrets").select("key,value").in("key", ["google_oauth_credentials"]);
  const credsRaw = (secretRows || []).find((r: any) => r.key === "google_oauth_credentials")?.value;
  if (!credsRaw) return json({ error: "google_oauth_credentials not set in app_secrets" }, 500);

  let creds: GoogleOAuthCreds;
  try {
    creds = JSON.parse(credsRaw);
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) throw new Error("missing client_id/client_secret/refresh_token");
  } catch (e) {
    return json({ error: `google_oauth_credentials is not valid: ${(e as Error).message}` }, 500);
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
    token = await getAccessToken(creds);
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
