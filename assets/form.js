/* Client Document Intake — upload form logic
   Uses the Supabase JS SDK with the INSERT-ONLY anon key. */
(function () {
  "use strict";
  var cfg = window.INTAKE_CONFIG;

  // Resolve the client slug: injected per-page by the admin generator, else
  // fall back to the first path segment (e.g. /acme/ -> "acme").
  var slug = (window.CLIENT_SLUG && window.CLIENT_SLUG !== "__CLIENT_SLUG__")
    ? window.CLIENT_SLUG
    : (location.pathname.split("/").filter(Boolean)[0] || "");

  // The public form is fully anonymous — it never signs in. Disabling session
  // persistence / auto-refresh keeps it from using GoTrue's navigator.locks
  // (which can deadlock) and avoids touching localStorage at all.
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
      storageKey: "wwc-intake-anon"   // isolates this app's auth lock from any other Supabase client on the domain
    }
  });

  var $ = function (sel) { return document.querySelector(sel); };
  var queue = [];          // {file, id, status, pct}
  var submitting = false;

  // ---------- Branding ----------
  async function loadBranding() {
    $(".firmname").textContent = cfg.FIRM_NAME;
    $(".firm").src = cfg.FIRM_LOGO;
    if (!slug) { showFatal("No client specified in the link. Please use the exact link your advisor sent you."); return; }
    try {
      var res = await sb.rpc("client_branding", { p_slug: slug });
      var row = (res.data && res.data[0]) || null;
      if (!row) { showFatal("This upload link is not active. Please contact your advisor for a current link."); return; }
      $("#clientName").textContent = row.name;
      $("#clientName").classList.remove("skeleton");
      document.title = row.name + " — Secure Document Upload";
      if (row.logo_url) {
        var img = $(".clientlogo");
        img.src = row.logo_url; img.alt = row.name; img.hidden = false;
      }
      $("#formCard").hidden = false;
    } catch (e) {
      showFatal("We couldn't load this page. Please refresh, or contact your advisor.");
    }
  }

  function showFatal(msg) {
    $("#formCard").hidden = true;
    $("#loadError").textContent = msg;
    $("#loadError").hidden = false;
    $("#clientName").textContent = "";
    $("#clientName").classList.remove("skeleton");
  }

  // ---------- File queue ----------
  function fmtSize(b) {
    if (b == null) return "";
    var u = ["B", "KB", "MB", "GB"], i = 0; b = Number(b);
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b : b.toFixed(1)) + " " + u[i];
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (f) {
      // de-dupe by name+size
      var dup = queue.some(function (q) { return q.file.name === f.name && q.file.size === f.size; });
      if (dup) return;
      queue.push({ file: f, id: "f" + queue.length + "_" + f.size, status: "wait", pct: 0 });
    });
    renderQueue();
  }

  function renderQueue() {
    var box = $("#files");
    box.innerHTML = "";
    queue.forEach(function (q, idx) {
      var el = document.createElement("div");
      el.className = "fileitem";
      var pill = { wait: ["wait", "Ready"], up: ["up", "Uploading"], done: ["done", "Uploaded"], fail: ["fail", "Failed"] }[q.status];
      el.innerHTML =
        '<span class="status-pill ' + pill[0] + '">' + pill[1] + '</span>' +
        '<div class="meta"><div class="fname"></div><div class="fsize"></div>' +
        '<div class="bar" ' + (q.status === "wait" ? "hidden" : "") + '><i style="width:' + q.pct + '%"></i></div></div>' +
        (q.status === "wait" && !submitting ? '<button class="rm" title="Remove" aria-label="Remove">&times;</button>' : "");
      el.querySelector(".fname").textContent = q.file.name;
      el.querySelector(".fsize").textContent = fmtSize(q.file.size);
      var rm = el.querySelector(".rm");
      if (rm) rm.addEventListener("click", function () { queue.splice(idx, 1); renderQueue(); });
      box.appendChild(el);
    });
    $("#submitBtn").disabled = (queue.length === 0 || submitting);
    var fc = $("#fileCount");
    if (fc) fc.textContent = queue.length ? "(" + queue.length + ")" : "";
  }

  // ---------- Key sanitization: only [A-Za-z0-9._-] ----------
  // Keeps the file extension intact (the dot separator is preserved).
  function sanitizeName(name) {
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot + 1) : "";   // extension WITHOUT the dot
    var cleanBase = function (s) {
      return s.normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
    };
    base = cleanBase(base) || "file";
    ext = ext.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "");  // letters/digits only
    return (ext ? base + "." + ext : base).slice(0, 120);
  }

  function objectKey(file) {
    // <slug>/<yyyymmddThhmmss>-<rand>-<safe-name>  (timestamp keeps order; rand avoids collisions)
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var ts = "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var rand = (window.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
    return slug + "/" + ts + "-" + rand + "-" + sanitizeName(file.name);
  }

  // ---------- Submit ----------
  function setBtnLabel(text) {
    var l = $("#submitLabel");
    if (l) l.textContent = text; else $("#submitBtn").firstChild && ($("#submitBtn").firstChild.textContent = text);
  }

  async function submit(e) {
    e.preventDefault();
    if (submitting || queue.length === 0) return;
    var name = $("#uName").value.trim();
    var email = $("#uEmail").value.trim();
    var note = $("#uNote").value.trim();

    submitting = true;
    $("#submitBtn").disabled = true;
    setBtnLabel("Uploading…");
    $("#formError").hidden = true;
    renderQueue();

    var failures = 0;
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      if (q.status === "done") continue;
      q.status = "up"; q.pct = 8; renderQueue();
      try {
        var key = objectKey(q.file);
        var up = await sb.storage.from(cfg.DOCS_BUCKET).upload(key, q.file, {
          contentType: q.file.type || "application/octet-stream",
          upsert: false
        });
        if (up.error) throw up.error;
        q.pct = 70; renderQueue();

        // INSERT-ONLY: plain .insert(), do NOT chain .select() (it would try to
        // read back the row, which insert-only policy forbids).
        var ins = await sb.from("submissions").insert({
          client_slug: slug,
          uploader_name: name || null,
          uploader_email: email || null,
          note: note || null,
          file_path: key,
          original_filename: q.file.name,
          size: q.file.size,
          content_type: q.file.type || null,
          source: "form"
        });
        if (ins.error) throw ins.error;

        q.status = "done"; q.pct = 100;
      } catch (err) {
        q.status = "fail"; q.pct = 0; failures++;
        console.error("Upload failed for", q.file.name, err);
      }
      renderQueue();
    }

    submitting = false;
    if (failures === 0) {
      showSuccess(queue.length);
    } else {
      $("#formError").textContent = failures + " file(s) didn't upload. Please remove the failed ones or try again.";
      $("#formError").hidden = false;
      $("#submitBtn").disabled = false;
      setBtnLabel("Retry upload");
    }
  }

  function showSuccess(n) {
    $("#formCard").hidden = true;
    $("#successCard").hidden = false;
    $("#successCount").textContent = n + (n === 1 ? " document" : " documents");
  }

  // ---------- Wire up ----------
  function init() {
    loadBranding();
    var dz = $("#drop"), input = $("#fileInput");
    dz.addEventListener("click", function () { input.click(); });
    dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", function () { addFiles(input.files); input.value = ""; });
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragover"); });
    });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
    $("#uploadForm").addEventListener("submit", submit);
    $("#uploadMore").addEventListener("click", function () {
      queue = []; submitting = false;
      $("#successCard").hidden = true; $("#formCard").hidden = false;
      setBtnLabel("Upload documents"); $("#submitBtn").disabled = true;
      renderQueue();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
