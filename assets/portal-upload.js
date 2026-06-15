/* portal-upload.js — compact upload widget embedded in the branded delivery
   page (/d/<id>/). Lets the client send signed copies back WITHOUT a separate
   link. Reuses the insert-only anon flow. Renders into <div id="signedUpload">. */
(function () {
  "use strict";
  var cfg = window.INTAKE_CONFIG;
  var slug = (window.CLIENT_SLUG && window.CLIENT_SLUG !== "__CLIENT_SLUG__") ? window.CLIENT_SLUG : null;
  var root = document.getElementById("signedUpload");
  if (!cfg || !slug || !root || !window.supabase) return;

  // Anonymous, insert-only — same config as the upload form (avoids GoTrue lock deadlock).
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "wwc-portal-anon" }
  });

  var queue = [], submitting = false;
  var $ = function (s) { return root.querySelector(s); };

  root.innerHTML =
    '<div class="field"><label for="pName">Your name (optional)</label>' +
      '<input id="pName" type="text" autocomplete="name" placeholder="Your name"></div>' +
    '<div id="pDrop" class="drop" tabindex="0" role="button" aria-label="Add files">' +
      '<div class="big">Drag &amp; drop your signed documents</div>' +
      '<div class="small">or <span class="browse">browse to choose</span></div></div>' +
    '<input id="pFile" type="file" multiple hidden>' +
    '<div id="pFiles" class="files"></div>' +
    '<div id="pErr" class="alert err" hidden></div>' +
    '<button id="pBtn" class="btn full" disabled><span id="pLabel">Send to us</span> <span id="pCount"></span></button>';

  function fmt(b) { var u = ["B", "KB", "MB", "GB"], i = 0; b = Number(b); while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i === 0 ? b : b.toFixed(1)) + " " + u[i]; }

  function add(list) {
    Array.prototype.forEach.call(list, function (f) {
      if (queue.some(function (q) { return q.file.name === f.name && q.file.size === f.size; })) return;
      queue.push({ file: f, status: "wait" });
    });
    render();
  }

  function render() {
    var box = $("#pFiles"); box.innerHTML = "";
    queue.forEach(function (q, idx) {
      var el = document.createElement("div"); el.className = "fileitem";
      var pill = { wait: ["wait", "Ready"], up: ["up", "Sending"], done: ["done", "Sent"], fail: ["fail", "Failed"] }[q.status];
      el.innerHTML = '<span class="status-pill ' + pill[0] + '">' + pill[1] + '</span>' +
        '<div class="meta"><div class="fname"></div><div class="fsize"></div></div>' +
        (q.status === "wait" && !submitting ? '<button class="rm" aria-label="Remove">&times;</button>' : "");
      el.querySelector(".fname").textContent = q.file.name;
      el.querySelector(".fsize").textContent = fmt(q.file.size);
      var rm = el.querySelector(".rm");
      if (rm) rm.addEventListener("click", function () { queue.splice(idx, 1); render(); });
      box.appendChild(el);
    });
    $("#pBtn").disabled = (queue.length === 0 || submitting);
    var c = $("#pCount"); if (c) c.textContent = queue.length ? "(" + queue.length + ")" : "";
  }

  function sanitize(name) {
    var dot = name.lastIndexOf("."); var base = dot > 0 ? name.slice(0, dot) : name; var ext = dot > 0 ? name.slice(dot + 1) : "";
    var cb = function (s) { return s.normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, ""); };
    base = cb(base) || "file"; ext = ext.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "");
    return (ext ? base + "." + ext : base).slice(0, 120);
  }
  function objectKey(file) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    var ts = "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "T" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    var r = (window.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
    return slug + "/" + ts + "-" + r + "-" + sanitize(file.name);
  }
  function setLabel(t) { var l = $("#pLabel"); if (l) l.textContent = t; }

  async function submit() {
    if (submitting || !queue.length) return;
    submitting = true; $("#pBtn").disabled = true; setLabel("Sending…"); $("#pErr").hidden = true; render();
    var name = $("#pName").value.trim(), fails = 0;
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i]; if (q.status === "done") continue;
      q.status = "up"; render();
      try {
        var k = objectKey(q.file);
        var up = await sb.storage.from(cfg.DOCS_BUCKET).upload(k, q.file, { contentType: q.file.type || "application/octet-stream", upsert: false });
        if (up.error) throw up.error;
        var ins = await sb.from("submissions").insert({
          client_slug: slug, uploader_name: name || null, note: "Returned via delivery portal (signed documents)",
          file_path: k, original_filename: q.file.name, size: q.file.size, content_type: q.file.type || null, source: "form"
        });
        if (ins.error) throw ins.error;
        q.status = "done";
      } catch (e) { q.status = "fail"; fails++; console.error("portal upload failed", q.file.name, e); }
      render();
    }
    submitting = false;
    if (fails === 0) {
      root.innerHTML = '<div class="success" style="padding:24px"><div class="check">&#10003;</div>' +
        '<h2>Got it — thank you!</h2><p>We received your signed documents. Your advisor will take it from here.</p></div>';
    } else {
      $("#pErr").textContent = fails + " file(s) didn’t send. Please remove the failed ones or try again.";
      $("#pErr").hidden = false; $("#pBtn").disabled = false; setLabel("Retry");
    }
  }

  var dz = $("#pDrop"), input = $("#pFile");
  dz.addEventListener("click", function () { input.click(); });
  dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", function () { add(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); }); });
  ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragover"); }); });
  dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files); });
  $("#pBtn").addEventListener("click", submit);
})();
