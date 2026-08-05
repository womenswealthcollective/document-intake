// Admin edge function — list / add / update clients, plus binder visibility.
// SECURITY: runs with the service role, but every request is gated to the ONE
// admin email (verified from the caller's Supabase JWT). The GitHub token and
// service role key never leave the server.
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

// --- UTF-8 safe base64 (btoa/atob are latin1-only) ---
const b64encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64decode = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

function github(S: Record<string, string>) {
  const base = `https://api.github.com/repos/${S.github_owner}/${S.github_repo}/contents`;
  const headers = {
    Authorization: `Bearer ${S.github_token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wwc-intake-admin",
  };
  return {
    async getFile(path: string): Promise<string> {
      const r = await fetch(`${base}/${encodeURI(path)}?ref=${S.github_branch}`, { headers });
      if (!r.ok) throw new Error(`getFile ${path}: ${r.status} ${await r.text()}`);
      const j = await r.json();
      return b64decode(j.content);
    },
    async putText(path: string, content: string, message: string) {
      let sha: string | undefined;
      const head = await fetch(`${base}/${encodeURI(path)}?ref=${S.github_branch}`, { headers });
      if (head.ok) sha = (await head.json()).sha;
      const r = await fetch(`${base}/${encodeURI(path)}`, {
        method: "PUT", headers,
        body: JSON.stringify({ message, content: b64encode(content), branch: S.github_branch, ...(sha ? { sha } : {}) }),
      });
      if (!r.ok) throw new Error(`putText ${path}: ${r.status} ${await r.text()}`);
      return r.json();
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ---------- AUTH GATE: must be the one admin email ----------
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user?.email) return json({ error: "unauthorized" }, 401);
  const email = ud.user.email.toLowerCase();

  const { data: secretRows } = await admin.from("app_secrets").select("key,value")
    .in("key", ["admin_email", "site_domain", "github_token", "github_owner", "github_repo", "github_branch"]);
  const S: Record<string, string> = Object.fromEntries((secretRows || []).map((r: any) => [r.key, r.value]));
  if (!S.admin_email || email !== S.admin_email.toLowerCase()) return json({ error: "forbidden" }, 403);

  // ---------- ROUTE ----------
  const body = await req.json().catch(() => ({} as any));
  const action = body.action;

  async function uploadLogo(slug: string): Promise<string | null> {
    if (!body.logo_base64 || !body.logo_filename) return null;
    const ext = (String(body.logo_filename).split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const bytes = Uint8Array.from(atob(String(body.logo_base64).replace(/\s/g, "")), (c) => c.charCodeAt(0));
    const path = `${slug}/logo.${ext}`;
    const { error } = await admin.storage.from("client-logos").upload(path, bytes, {
      contentType: body.logo_content_type || "image/png", upsert: true,
    });
    if (error) throw new Error("logo upload: " + error.message);
    return admin.storage.from("client-logos").getPublicUrl(path).data.publicUrl;
  }

  try {
    if (action === "list") {
      const { data, error } = await admin.from("clients")
        .select("slug,name,logo_url,drive_folder_id,active,created_at").order("created_at", { ascending: false });
      if (error) throw error;
      return json({ clients: data, site_domain: S.site_domain });
    }

    if (action === "add") {
      const slug = String(body.slug || "").toLowerCase().trim();
      const name = String(body.name || "").trim();
      if (!/^[a-z0-9-]+$/.test(slug)) return json({ error: "Slug must be lowercase letters, numbers, and hyphens only." }, 400);
      if (slug.length < 2 || slug.length > 40) return json({ error: "Slug must be 2-40 characters." }, 400);
      if (["admin", "assets", "_template"].includes(slug)) return json({ error: "That slug is reserved." }, 400);
      if (!name) return json({ error: "Client name is required." }, 400);

      const { data: existing } = await admin.from("clients").select("slug").eq("slug", slug).maybeSingle();
      if (existing) return json({ error: `A client with slug "${slug}" already exists.` }, 409);

      const logo_url = await uploadLogo(slug);

      // generate the client's form page from the template and commit it
      const gh = github(S);
      const tpl = await gh.getFile("_template/index.html");
      const page = tpl.replace(/__CLIENT_SLUG__/g, slug);
      await gh.putText(`${slug}/index.html`, page, `Add client form: ${slug}`);

      // insert the row (plain insert — no .select() needed)
      const { error: insErr } = await admin.from("clients").insert({ slug, name, logo_url, active: true });
      if (insErr) throw insErr;

      return json({ ok: true, slug, name, logo_url, form_url: `https://${S.site_domain}/${slug}/` });
    }

    if (action === "update") {
      const slug = String(body.slug || "").toLowerCase().trim();
      if (!/^[a-z0-9-]+$/.test(slug)) return json({ error: "bad slug" }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
      if (typeof body.active === "boolean") patch.active = body.active;
      const logo_url = await uploadLogo(slug);
      if (logo_url) patch.logo_url = logo_url;
      if (Object.keys(patch).length === 0) return json({ error: "nothing to update" }, 400);
      const { error } = await admin.from("clients").update(patch).eq("slug", slug);
      if (error) throw error;
      return json({ ok: true, slug, ...patch });
    }

    // ---------- bulk client import (e.g. from a Drake client-list CSV export) ----------
    if (action === "bulk_add") {
      const rows = Array.isArray(body.clients) ? body.clients : [];
      if (rows.length === 0) return json({ error: "No rows provided." }, 400);
      if (rows.length > 200) return json({ error: "Max 200 rows per bulk import." }, 400);

      const gh = github(S);
      const tpl = await gh.getFile("_template/index.html");
      const results: Record<string, unknown>[] = [];

      for (const row of rows) {
        const name = String(row.name || "").trim();
        let slug = String(row.slug || "").toLowerCase().trim();
        if (!slug && name) slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

        if (!name) { results.push({ name: row.name ?? null, ok: false, error: "missing name" }); continue; }
        if (!/^[a-z0-9-]+$/.test(slug) || slug.length < 2) { results.push({ name, slug, ok: false, error: "could not derive a valid slug" }); continue; }
        if (["admin", "assets", "_template"].includes(slug)) { results.push({ name, slug, ok: false, error: "reserved slug" }); continue; }

        try {
          const { data: existing } = await admin.from("clients").select("slug").eq("slug", slug).maybeSingle();
          if (existing) { results.push({ name, slug, ok: false, error: "already exists" }); continue; }

          const page = tpl.replace(/__CLIENT_SLUG__/g, slug);
          await gh.putText(`${slug}/index.html`, page, `Add client form (bulk import): ${slug}`);

          const { error: insErr } = await admin.from("clients").insert({ slug, name, active: true });
          if (insErr) throw insErr;

          results.push({ name, slug, ok: true, form_url: `https://${S.site_domain}/${slug}/` });
        } catch (e) {
          results.push({ name, slug, ok: false, error: String((e as Error).message || e) });
        }
      }

      return json({ imported: results.filter((r) => r.ok).length, total: rows.length, results });
    }

    // ---------- binder visibility ----------
    if (action === "list_submissions") {
      let q = admin.from("submissions")
        .select("id, client_slug, uploader_name, original_filename, source, status, created_at, processed_at")
        .order("created_at", { ascending: false }).limit(200);
      if (typeof body.status === "string") q = q.eq("status", body.status);
      const { data, error } = await q;
      if (error) throw error;
      return json({ submissions: data });
    }

    if (action === "list_needs_review") {
      const { data, error } = await admin.from("client_documents")
        .select("id, client_slug, tax_year, extracted_label, renamed_filename, classification_notes, created_at, document_types(code,label), submissions(original_filename)")
        .eq("status", "needs_review").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ items: data });
    }

    if (action === "client_binder") {
      const slug = String(body.slug || "").toLowerCase().trim();
      if (!/^[a-z0-9-]+$/.test(slug)) return json({ error: "bad slug" }, 400);

      const [{ data: types, error: tErr }, { data: docs, error: dErr }] = await Promise.all([
        admin.from("document_types").select("id,code,label,sort_order").order("sort_order", { ascending: true }),
        admin.from("client_documents")
          .select("id, document_type_id, tax_year, extracted_label, renamed_filename, drive_file_id, status, classification_notes, created_at")
          .eq("client_slug", slug).order("created_at", { ascending: false }),
      ]);
      if (tErr) throw tErr;
      if (dErr) throw dErr;

      const receivedByType = new Map<number, any[]>();
      for (const d of docs || []) {
        if (d.document_type_id == null) continue;
        const arr = receivedByType.get(d.document_type_id) || [];
        arr.push(d);
        receivedByType.set(d.document_type_id, arr);
      }
      const checklist = (types || []).map((t: any) => ({
        code: t.code, label: t.label,
        documents: (receivedByType.get(t.id) || []).filter((d) => d.status !== "needs_review"),
      }));
      const needsReview = (docs || []).filter((d) => d.status === "needs_review");

      return json({ slug, checklist, needs_review: needsReview });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
