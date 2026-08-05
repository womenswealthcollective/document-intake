// process-submission — the "binder" auto-classification pipeline.
// Invoked on a schedule (pg_cron -> pg_net) with the service role key as the
// bearer token. Pulls pending submissions, asks Claude to classify each
// document, renames it per a standard convention, and records the result in
// client_documents. Does NOT push to Drive yet — that's process-submission's
// companion step once Google service-account credentials exist (see
// push-to-drive, added in a later phase).
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";
const BATCH_LIMIT = 20;

// Claude's document/vision understanding only accepts these directly.
// Anything else (e.g. HEIC) is left for manual review rather than guessed at.
const SUPPORTED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function sanitizeLabel(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unknown";
}

function extOf(path: string, contentType: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (m) return m[1].toLowerCase();
  const byType: Record<string, string> = {
    "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg",
    "image/webp": "webp", "image/gif": "gif",
  };
  return (contentType && byType[contentType]) || "bin";
}

function b64encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface Classification {
  document_type_code: string;
  tax_year: number | null;
  extracted_label: string | null;
  confidence: number;
  notes: string | null;
}

async function classify(anthropicKey: string, mediaType: string, base64: string, knownCodes: string[]): Promise<Classification> {
  const isPdf = mediaType === "application/pdf";
  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const prompt =
    `You are sorting a client's tax documents for a CPA firm. Classify the attached file.\n\n` +
    `Valid document_type_code values: ${knownCodes.join(", ")}.\n` +
    `If it doesn't clearly match one of these, use "other".\n\n` +
    `Respond with ONLY a JSON object (no prose, no markdown fences) shaped exactly like:\n` +
    `{"document_type_code": string, "tax_year": number|null, "extracted_label": string|null, "confidence": number, "notes": string|null}\n\n` +
    `- tax_year: the tax year this document applies to, if determinable (e.g. a 2025 W-2 covers tax_year 2025).\n` +
    `- extracted_label: the payer or employer name on the document, if present (short, no punctuation beyond spaces/hyphens).\n` +
    `- confidence: 0 to 1, how sure you are of document_type_code.\n` +
    `- notes: anything a preparer should know (illegible, multiple documents in one file, etc), else null.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b: any) => b.text || "").join("").trim();
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: Classification;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`could not parse model response as JSON: ${text.slice(0, 200)}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: secretRows } = await admin.from("app_secrets").select("key,value").in("key", ["anthropic_api_key"]);
  const anthropicKey = (secretRows || []).find((r: any) => r.key === "anthropic_api_key")?.value;
  if (!anthropicKey) return json({ error: "anthropic_api_key not set in app_secrets" }, 500);

  const { data: docTypes, error: dtErr } = await admin.from("document_types").select("id,code");
  if (dtErr) return json({ error: dtErr.message }, 500);
  const codeToId = new Map<string, number>((docTypes || []).map((d: any) => [d.code, d.id]));
  const knownCodes = Array.from(codeToId.keys());

  const { data: pending, error: pErr } = await admin
    .from("submissions")
    .select("id, client_slug, file_path, original_filename, content_type")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (pErr) return json({ error: pErr.message }, 500);

  const results: Record<string, unknown>[] = [];

  for (const sub of pending || []) {
    try {
      // Mark as downloaded before we do the (potentially slow) classification work.
      await admin.from("submissions").update({ status: "downloaded", downloaded_at: new Date().toISOString() }).eq("id", sub.id);

      const { data: fileBlob, error: dlErr } = await admin.storage.from("client-docs").download(sub.file_path);
      if (dlErr) throw new Error(`download: ${dlErr.message}`);

      const mediaType = sub.content_type || "application/octet-stream";
      if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
        await admin.from("client_documents").insert({
          submission_id: sub.id, client_slug: sub.client_slug,
          document_type_id: codeToId.get("other") ?? null,
          status: "needs_review",
          classification_notes: `Unsupported file type for auto-classification: ${mediaType}`,
        });
        await admin.from("submissions").update({ status: "processed", processed_at: new Date().toISOString() }).eq("id", sub.id);
        results.push({ id: sub.id, status: "needs_review", reason: "unsupported_media_type" });
        continue;
      }

      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      const base64 = b64encodeBytes(bytes);
      const cls = await classify(anthropicKey, mediaType, base64, knownCodes);

      const code = codeToId.has(cls.document_type_code) ? cls.document_type_code : "other";
      const needsReview = code === "other" || (cls.confidence ?? 0) < 0.6;
      const label = cls.extracted_label ? sanitizeLabel(cls.extracted_label) : null;
      const yearPart = cls.tax_year ? String(cls.tax_year) : "unknown-year";
      const ext = extOf(sub.file_path, sub.content_type);
      const renamed = [yearPart, code, label].filter(Boolean).join("_") + "." + ext;

      await admin.from("client_documents").insert({
        submission_id: sub.id,
        client_slug: sub.client_slug,
        document_type_id: codeToId.get(code) ?? null,
        tax_year: cls.tax_year ?? null,
        extracted_label: cls.extracted_label ?? null,
        renamed_filename: renamed,
        status: needsReview ? "needs_review" : "classified",
        classification_notes: cls.notes ?? null,
      });
      await admin.from("submissions").update({ status: "processed", processed_at: new Date().toISOString() }).eq("id", sub.id);
      results.push({ id: sub.id, status: needsReview ? "needs_review" : "classified", document_type_code: code });
    } catch (e) {
      await admin.from("submissions").update({ status: "error" }).eq("id", sub.id);
      results.push({ id: sub.id, status: "error", error: String((e as Error).message || e) });
    }
  }

  return json({ processed: results.length, results });
});
