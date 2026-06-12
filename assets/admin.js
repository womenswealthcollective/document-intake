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
  }

  // ---------- edge function calls ----------
  async function callFn(payload) {
    var r = await sb.functions.invoke("admin", { body: payload });
    if (r.error) {
      // try to surface the function's JSON error message
      var detail = r.error.message || "request failed";
      try { if (r.error.context && r.error.context.json) { var j = await r.error.context.json(); if (j && j.error) detail = j.error; } } catch (e) {}
      throw new Error(detail);
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }

  // ---------- clients list ----------
  async function loadClients() {
    try {
      var data = await callFn({ action: "list" });
      renderClients(data.clients || []);
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
