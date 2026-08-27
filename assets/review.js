/* Workpaper Review Layer — /review/ page logic.
   Staff-only. Security is enforced by Postgres RLS (is_staff()), NOT by this
   script — the client-side is_staff() check below is UX only, same relation
   as admin.js's ADMIN_EMAIL check to the admin edge function's real gate.

   This file is loaded as a real ES module (<script type="module">) because
   pdfjs-dist v4+ ships ESM-only (no classic global-script build exists in
   this package anymore, confirmed against the published file listing) —
   unlike supabase-js, which still loads as a classic global script below.
   Pinned to a verified version rather than a floating "@4" tag. */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";

// Browsers refuse to construct a Worker directly from a cross-origin URL
// (confirmed: "Failed to construct 'Worker': Script ... cannot be accessed
// from origin ..."). page.render() then hangs forever instead of erroring,
// because pdf.js's internal worker-setup failure isn't surfaced as a clean
// rejection. Fix: fetch the worker script ourselves and load it from a
// same-origin blob: URL — the standard workaround for cross-origin workers.
// Top-level await works because this file is a real ES module.
const workerBlobUrl = await fetch("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs")
  .then(function (r) { return r.text(); })
  .then(function (text) { return URL.createObjectURL(new Blob([text], { type: "application/javascript" })); });

(function () {
  "use strict";
  var cfg = window.INTAKE_CONFIG;

  // Persists the session (staff need to stay logged in) and detects the
  // magic-link token in the URL. Dedicated storageKey, separate from the
  // anon intake client and the /admin/ session.
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "wwc-review" }
  });

  pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

  var $ = function (s) { return document.querySelector(s); };
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function msg(id, text, kind) {
    var el = $(id); if (!el) return;
    el.textContent = text || ""; el.hidden = !text;
    el.className = "alert" + (kind === "err" ? " err" : "");
    if (kind === "ok") { el.style.background = "#e3f6f1"; el.style.color = "var(--teal)"; el.style.border = "1px solid #b8e6db"; }
    else { el.style.background = ""; el.style.color = ""; el.style.border = ""; }
  }

  // ---------- viewer state ----------
  var state = { pdfDoc: null, pageNum: 1, pageCount: 0, scaleIdx: 2, docId: null };
  var SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];

  // ---------- session / routing ----------
  async function boot() {
    var res = await sb.auth.getSession();
    var session = res.data.session;
    if (session && session.user) {
      var staffRes = await sb.rpc("is_staff");
      if (staffRes.data === true) { enterReviewer(session.user.email); return; }
      await sb.auth.signOut();
      show("#bootMsg", false); show("#reviewerCard", false); show("#loginCard", true);
      msg("#loginMsg", "That account is not on the staff list for this tool.", "err");
    } else {
      show("#bootMsg", false); show("#loginCard", true);
    }
  }

  sb.auth.onAuthStateChange(async function (event, session) {
    if (event === "SIGNED_IN" && session && session.user) {
      var staffRes = await sb.rpc("is_staff");
      if (staffRes.data === true) { enterReviewer(session.user.email); return; }
      await sb.auth.signOut();
      show("#reviewerCard", false); show("#loginCard", true);
      msg("#loginMsg", "That account is not on the staff list for this tool.", "err");
    }
    if (event === "SIGNED_OUT") { show("#reviewerCard", false); show("#loginCard", true); }
  });

  function enterReviewer(email) {
    show("#bootMsg", false); show("#loginCard", false); show("#reviewerCard", true);
    $("#whoami").textContent = email;
    loadClients();
  }

  // ---------- clients ----------
  async function loadClients() {
    var res = await sb.from("clients").select("slug,name,active").order("name");
    if (res.error) { console.error(res.error); return; }
    var box = $("#clientList"); box.innerHTML = "";
    (res.data || []).forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-item"; b.dataset.slug = c.slug;
      b.innerHTML = c.name + (c.active ? "" : ' <span class="rv-sub">(inactive)</span>');
      b.addEventListener("click", function () { selectClient(c.slug, b); });
      box.appendChild(b);
    });
  }

  function selectClient(slug, btn) {
    document.querySelectorAll("#clientList .rv-item").forEach(function (b) { b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
    show("#docsHeading", true);
    loadDocuments(slug);
  }

  // ---------- documents ----------
  async function loadDocuments(slug) {
    var res = await sb.from("workpaper_documents").select("id,title,category,storage_path")
      .eq("client_slug", slug).order("created_at", { ascending: false });
    if (res.error) { console.error(res.error); return; }
    var box = $("#docList"); box.innerHTML = "";
    if (!res.data || !res.data.length) {
      box.innerHTML = '<div class="rv-sub" style="padding:8px 16px;color:var(--muted)">No documents yet.</div>';
      return;
    }
    res.data.forEach(function (d) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-item";
      b.innerHTML = escapeHtml(d.title) + (d.category ? '<span class="rv-sub">' + escapeHtml(d.category) + "</span>" : "");
      b.addEventListener("click", function () {
        document.querySelectorAll("#docList .rv-item").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        openDocument(d);
      });
      box.appendChild(b);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  // ---------- pdf viewer ----------
  async function openDocument(doc) {
    $("#rvEmpty").hidden = true;
    setToolbarEnabled(false);
    $("#pageNum").textContent = "Loading…";
    var dl = await sb.storage.from("workpaper-docs").download(doc.storage_path);
    if (dl.error) { console.error(dl.error); $("#pageNum").textContent = "Error"; return; }
    var buf = await dl.data.arrayBuffer();
    var task = pdfjsLib.getDocument({ data: buf });
    var pdfDoc = await task.promise;
    state.pdfDoc = pdfDoc; state.pageNum = 1; state.pageCount = pdfDoc.numPages; state.docId = doc.id;
    setToolbarEnabled(true);
    renderPage();
  }

  function setToolbarEnabled(on) {
    ["#prevPage", "#nextPage", "#zoomOut", "#zoomIn"].forEach(function (id) { $(id).disabled = !on; });
  }

  async function renderPage() {
    if (!state.pdfDoc) return;
    var page = await state.pdfDoc.getPage(state.pageNum);
    var scale = SCALES[state.scaleIdx];
    var viewport = page.getViewport({ scale: scale });

    var wrap = $("#canvasWrap");
    wrap.innerHTML = "";
    var shell = document.createElement("div");
    shell.className = "rv-page-shell";
    shell.style.width = viewport.width + "px";
    shell.style.height = viewport.height + "px";
    var canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    shell.appendChild(canvas);
    wrap.appendChild(shell);

    var ctx = canvas.getContext("2d");
    var renderTask = page.render({ canvasContext: ctx, viewport: viewport });
    // WITHOUT this, render() hangs forever in some embedded/WebView browser
    // hosts (confirmed via direct testing) — pdf.js's default progressive
    // rendering yields via an internal scheduling mechanism (rAF-based) that
    // doesn't reliably fire in every host, even when document.visibilityState
    // reports "visible". Forcing an immediate continuation sidesteps it and
    // is harmless in normal browsers too.
    renderTask.onContinue = function (cont) { cont(); };
    await renderTask.promise;

    $("#pageNum").textContent = state.pageNum + " / " + state.pageCount;
    $("#zoomLevel").textContent = Math.round(scale * 100) + "%";
    $("#prevPage").disabled = state.pageNum <= 1;
    $("#nextPage").disabled = state.pageNum >= state.pageCount;
    $("#zoomOut").disabled = state.scaleIdx <= 0;
    $("#zoomIn").disabled = state.scaleIdx >= SCALES.length - 1;
  }

  // ---------- wire up ----------
  function init() {
    show("#loginCard", false); show("#reviewerCard", false);

    $("#loginBtn").addEventListener("click", async function () {
      var email = $("#email").value.trim();
      if (!email) { msg("#loginMsg", "Enter your email.", "err"); return; }
      $("#loginBtn").disabled = true;
      try {
        var r = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + "/review/" } });
        if (r.error) throw r.error;
        msg("#loginMsg", "Check your inbox — we emailed a login link to " + email + ".", "ok");
      } catch (e) { msg("#loginMsg", e.message, "err"); }
      $("#loginBtn").disabled = false;
    });

    $("#signOut").addEventListener("click", function () { sb.auth.signOut(); });

    $("#prevPage").addEventListener("click", function () { if (state.pageNum > 1) { state.pageNum--; renderPage(); } });
    $("#nextPage").addEventListener("click", function () { if (state.pageNum < state.pageCount) { state.pageNum++; renderPage(); } });
    $("#zoomOut").addEventListener("click", function () { if (state.scaleIdx > 0) { state.scaleIdx--; renderPage(); } });
    $("#zoomIn").addEventListener("click", function () { if (state.scaleIdx < SCALES.length - 1) { state.scaleIdx++; renderPage(); } });

    boot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
