/* Admin page logic — magic-link login (admin email only) + client management.
   All privileged work happens in the `admin` edge function, which independently
   re-verifies the admin email server-side. This page is just the UI. */
(function () {
  "use strict";
  var cfg = window.INTAKE_CONFIG;
  var ADMIN_EMAIL = "dimpy.gulati@womenswealthcollective360.com";
  var SITE = cfg.SITE_DOMAIN;

  // Admin client DOES persist the session (we need to stay logged in) and must
  // detect the magic-link tokens in the URL. Dedicated storageKey.
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "wwc-admin" }
  });

  var $ = function (s) { return document.querySelector(s); };
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function msg(id, text, kind) {
    var el = $(id); if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.className = "alert" + (kind === "err" ? " err" : kind === "ok" ? "" : "");
    if (kind === "ok") { el.style.background = "#e3f6f1"; el.style.color = "var(--teal)"; el.style.border = "1px solid #b8e6db"; }
    else { el.style.background = ""; el.style.color = ""; el.style.border = ""; }
  }

  // ---------- session / routing ----------
  async function boot() {
    var res = await sb.auth.getSession();
    var session = res.data.session;
    if (session && session.user && (session.user.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      enterAdmin(session.user.email);
    } else if (session && session.user) {
      // signed in but wrong email — block
      await sb.auth.signOut();
      show("#bootMsg", false); show("#adminCard", false); show("#loginCard", true);
      msg("#loginMsg", "That email is not authorized for admin access.", "err");
    } else {
      show("#bootMsg", false); show("#loginCard", true);
    }
  }

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_IN" && session && session.user) {
      if ((session.user.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase()) enterAdmin(session.user.email);
      else { sb.auth.signOut(); msg("#loginMsg", "That email is not authorized for admin access.", "err"); show("#loginCard", true); show("#adminCard", false); }
    }
    if (event === "SIGNED_OUT") { show("#adminCard", false); show("#loginCard", true); }
  });

  function enterAdmin(email) {
    show("#bootMsg", false); show("#loginCard", false); show("#adminCard", true);
    $("#whoami").textContent = email;
    loadClients();
    loadNeedsReview();
  }

  // ---------- edge function calls ----------
  async function callFnNamed(fnName, payload) {
    var r = await sb.functions.invoke(fnName, { body: payload || {} });
    if (r.error) {
      // try to surface the function's JSON error message
      var detail = r.error.message || "request failed";
      try { if (r.error.context && r.error.context.json) { var j = await r.error.context.json(); if (j && j.error) detail = j.error; } } catch (e) {}
      throw new Error(detail);
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }
  function callFn(payload) { return callFnNamed("admin", payload); }

  // ---------- clients list ----------
  var lastClients = [];

  async function loadClients() {
    try {
      var data = await callFn({ action: "list" });
      lastClients = data.clients || [];
      renderClients(lastClients);
      populateBinderSelect(lastClients);
    } catch (e) {
      msg("#addMsg", "Couldn't load clients: " + e.message, "err");
    }
  }

  function formUrl(slug) { return "https://" + SITE + "/" + slug + "/"; }

  function renderClients(clients) {
    var body = $("#clientsBody"); body.innerHTML = "";
    show("#clientsTable", clients.length > 0);
    show("#clientsEmpty", clients.length === 0);
    clients.forEach(function (c) {
      var tr = document.createElement("tr");
      var url = formUrl(c.slug);
      tr.innerHTML =
        '<td>' + (c.logo_url ? '<img class="logo-thumb" src="' + c.logo_url + '" alt=""> ' : '') +
          '<strong>' + escapeHtml(c.name) + '</strong><div style="color:var(--muted);font-size:12px">' + escapeHtml(c.slug) + '</div></td>' +
        '<td><div class="url-cell"><code title="' + url + '">' + url + '</code>' +
          '<button class="mini" data-copy="' + url + '">Copy</button></div></td>' +
        '<td><span class="badge ' + (c.active ? 'on">Active' : 'off">Off') + '</span></td>' +
        '<td style="text-align:right">' +
          '<button class="mini" data-toggle="' + c.slug + '" data-active="' + (c.active ? '1' : '0') + '">' + (c.active ? 'Deactivate' : 'Activate') + '</button> ' +
          '<button class="mini" data-rename="' + c.slug + '" data-name="' + escapeAttr(c.name) + '">Rename</button>' +
        '</td>';
      body.appendChild(tr);
    });
    body.querySelectorAll("[data-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
          var t = b.textContent; b.textContent = "Copied!"; setTimeout(function () { b.textContent = t; }, 1200);
        });
      });
    });
    body.querySelectorAll("[data-toggle]").forEach(function (b) {
      b.addEventListener("click", async function () {
        b.disabled = true;
        try { await callFn({ action: "update", slug: b.getAttribute("data-toggle"), active: b.getAttribute("data-active") !== "1" }); await loadClients(); }
        catch (e) { msg("#addMsg", e.message, "err"); b.disabled = false; }
      });
    });
    body.querySelectorAll("[data-rename]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var name = prompt("New name for this client:", b.getAttribute("data-name"));
        if (name == null || !name.trim()) return;
        try { await callFn({ action: "update", slug: b.getAttribute("data-rename"), name: name.trim() }); await loadClients(); }
        catch (e) { msg("#addMsg", e.message, "err"); }
      });
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = reject; r.readAsDataURL(file);
    });
  }

  // ---------- needs review ----------
  async function loadNeedsReview() {
    try {
      var data = await callFn({ action: "list_needs_review" });
      renderNeedsReview(data.items || []);
    } catch (e) {
      msg("#addMsg", "Couldn't load needs-review items: " + e.message, "err");
    }
  }

  function renderNeedsReview(items) {
    var body = $("#reviewBody"); body.innerHTML = "";
    show("#reviewTable", items.length > 0);
    show("#reviewEmpty", items.length === 0);
    items.forEach(function (it) {
      var tr = document.createElement("tr");
      var dt = it.document_types;
      var guess = dt ? escapeHtml(dt.label) : "Unclassified";
      var fname = it.submissions ? escapeHtml(it.submissions.original_filename || "") : "";
      tr.innerHTML =
        "<td><strong>" + escapeHtml(it.client_slug) + "</strong></td>" +
        "<td>" + fname + "</td>" +
        "<td>" + guess + (it.extracted_label ? " &middot; " + escapeHtml(it.extracted_label) : "") + "</td>" +
        "<td style='color:var(--muted);font-size:13px'>" + escapeHtml(it.classification_notes || "") + "</td>";
      body.appendChild(tr);
    });
  }

  // ---------- client binder ----------
  function populateBinderSelect(clients) {
    var sel = $("#binderClient");
    var current = sel.value;
    sel.innerHTML = '<option value="">Choose a client…</option>';
    clients.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.slug; opt.textContent = c.name + " (" + c.slug + ")";
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  async function loadBinder(slug) {
    var wrap = $("#binderWrap");
    if (!slug) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = '<p class="sub">Loading…</p>';
    try {
      var data = await callFn({ action: "client_binder", slug: slug });
      renderBinder(data);
    } catch (e) {
      wrap.innerHTML = '<div class="alert err">' + escapeHtml(e.message) + "</div>";
    }
  }

  function renderBinder(data) {
    var wrap = $("#binderWrap");
    var grid = document.createElement("div");
    grid.className = "check-grid";
    (data.checklist || []).forEach(function (item) {
      var got = item.documents.length > 0;
      var cell = document.createElement("div");
      cell.className = "check-item " + (got ? "got" : "missing");
      cell.innerHTML = '<span class="check-dot"></span><span>' + escapeHtml(item.label) +
        (got ? " (" + item.documents.length + ")" : "") + "</span>";
      grid.appendChild(cell);
    });
    wrap.innerHTML = "";
    wrap.appendChild(grid);

    if (data.needs_review && data.needs_review.length) {
      var note = document.createElement("p");
      note.className = "sub";
      note.style.marginTop = "14px";
      note.textContent = data.needs_review.length + " document(s) for this client need manual review (see Needs Review above).";
      wrap.appendChild(note);
    }
  }

  // ---------- bulk import (CSV) ----------
  var bulkRows = [];

  function parseCsv(text) {
    var rows = [], row = [], field = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = ""; rows.push(row); row = [];
      } else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ""; }); });
  }

  function rowsToClients(rows) {
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var nameIdx = header.indexOf("name");
    if (nameIdx === -1) nameIdx = header.findIndex(function (h) { return h.indexOf("name") !== -1; });
    if (nameIdx === -1) nameIdx = 0;
    var slugIdx = header.indexOf("slug");
    var dataRows = rows.slice(1);
    return dataRows.map(function (r) {
      var out = { name: (r[nameIdx] || "").trim() };
      if (slugIdx !== -1 && r[slugIdx]) out.slug = r[slugIdx].trim().toLowerCase();
      return out;
    }).filter(function (r) { return r.name; });
  }

  function renderBulkResults(res) {
    var box = $("#bulkResults"); box.innerHTML = "";
    if (!res || !res.results) return;
    var table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML = "<thead><tr><th>Name</th><th>Slug</th><th>Result</th></tr></thead>";
    var tbody = document.createElement("tbody");
    res.results.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + escapeHtml(r.name || "") + "</td><td>" + escapeHtml(r.slug || "") + "</td><td>" +
        (r.ok ? '<span class="badge on">Added</span>' : '<span class="badge off">' + escapeHtml(r.error || "Failed") + "</span>") + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  // ---------- wire up ----------
  function init() {
    show("#loginCard", false); show("#adminCard", false);

    $("#loginBtn").addEventListener("click", async function () {
      var email = $("#email").value.trim();
      if (!email) { msg("#loginMsg", "Enter your email.", "err"); return; }
      $("#loginBtn").disabled = true;
      try {
        var r = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + "/admin/" } });
        if (r.error) throw r.error;
        msg("#loginMsg", "Check your inbox — we emailed a login link to " + email + ". (Only the authorized admin email can actually sign in.)", "ok");
      } catch (e) { msg("#loginMsg", e.message, "err"); }
      $("#loginBtn").disabled = false;
    });

    $("#signOut").addEventListener("click", function () { sb.auth.signOut(); });
    $("#refreshBtn").addEventListener("click", loadClients);
    $("#reviewRefreshBtn").addEventListener("click", loadNeedsReview);
    $("#binderClient").addEventListener("change", function () { loadBinder($("#binderClient").value); });

    $("#runClassifyBtn").addEventListener("click", async function () {
      $("#runClassifyBtn").disabled = true;
      msg("#runClassifyMsg", "Running…", "ok");
      try {
        var res = await callFnNamed("process-submission", {});
        msg("#runClassifyMsg", "Processed " + res.processed + " submission(s).", "ok");
        await loadNeedsReview();
      } catch (e) {
        msg("#runClassifyMsg", e.message, "err");
      }
      $("#runClassifyBtn").disabled = false;
    });

    $("#runDriveBtn").addEventListener("click", async function () {
      $("#runDriveBtn").disabled = true;
      msg("#runDriveMsg", "Running…", "ok");
      try {
        var res = await callFnNamed("push-to-drive", {});
        msg("#runDriveMsg", "Processed " + res.processed + " document(s).", "ok");
        var slug = $("#binderClient").value;
        if (slug) await loadBinder(slug);
      } catch (e) {
        msg("#runDriveMsg", e.message, "err");
      }
      $("#runDriveBtn").disabled = false;
    });

    $("#bulkFile").addEventListener("change", async function () {
      var file = $("#bulkFile").files[0];
      $("#bulkResults").innerHTML = ""; show("#bulkMsg", false);
      if (!file) { bulkRows = []; show("#bulkPreview", false); $("#bulkBtn").disabled = true; return; }
      var text = await file.text();
      bulkRows = rowsToClients(parseCsv(text));
      show("#bulkPreview", true);
      $("#bulkPreview").textContent = bulkRows.length + " client(s) found in " + file.name + ".";
      $("#bulkBtn").disabled = bulkRows.length === 0;
    });

    $("#bulkBtn").addEventListener("click", async function () {
      if (!bulkRows.length) return;
      $("#bulkBtn").disabled = true;
      msg("#bulkMsg", "Importing " + bulkRows.length + " client(s)…", "ok");
      try {
        var res = await callFn({ action: "bulk_add", clients: bulkRows });
        msg("#bulkMsg", "Imported " + res.imported + " of " + res.total + " client(s).", res.imported === res.total ? "ok" : "err");
        renderBulkResults(res);
        await loadClients();
      } catch (e) {
        msg("#bulkMsg", e.message, "err");
      }
      $("#bulkBtn").disabled = false;
    });

    $("#cSlug").addEventListener("input", function () {
      $("#slugPreview").textContent = $("#cSlug").value.trim() || "slug";
    });
    // auto-suggest slug from name
    $("#cName").addEventListener("input", function () {
      if ($("#cSlug").dataset.touched) return;
      var s = $("#cName").value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      $("#cSlug").value = s; $("#slugPreview").textContent = s || "slug";
    });
    $("#cSlug").addEventListener("keydown", function () { $("#cSlug").dataset.touched = "1"; });

    $("#addBtn").addEventListener("click", async function () {
      var name = $("#cName").value.trim();
      var slug = $("#cSlug").value.trim().toLowerCase();
      var logo = $("#cLogo").files[0];
      if (!name) { msg("#addMsg", "Client name is required.", "err"); return; }
      if (!/^[a-z0-9-]+$/.test(slug)) { msg("#addMsg", "Slug must be lowercase letters, numbers, hyphens.", "err"); return; }
      $("#addBtn").disabled = true; msg("#addMsg", "Creating client and committing the form page…", "ok");
      try {
        var payload = { action: "add", slug: slug, name: name };
        if (logo) { payload.logo_base64 = await fileToBase64(logo); payload.logo_filename = logo.name; payload.logo_content_type = logo.type; }
        var res = await callFn(payload);
        msg("#addMsg", "✓ Added " + res.name + ". Form: " + res.form_url + " (live in ~1 min while the page builds).", "ok");
        $("#cName").value = ""; $("#cSlug").value = ""; $("#cLogo").value = ""; delete $("#cSlug").dataset.touched;
        $("#slugPreview").textContent = "slug";
        await loadClients();
      } catch (e) { msg("#addMsg", e.message, "err"); }
      $("#addBtn").disabled = false;
    });

    boot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
