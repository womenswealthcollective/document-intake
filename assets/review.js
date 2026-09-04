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
// pdf-lib writes the flattened export. Isomorphic + ESM, so it loads straight
// from the CDN with no build step (version verified against the published
// file listing before pinning).
import { PDFDocument, StandardFonts, rgb } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";

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
  var allClients = [];      // full list from the DB; the sidebar renders a filtered view
  var selectedSlug = null;  // keeps the highlight correct across re-filters

  // ---- annotation state (M4) ----
  // Coordinates are stored NORMALIZED (0..1 of page width/height) so marks stay
  // correctly positioned at any zoom level and on any screen.
  var tool = { type: "none", symbol: null };
  var annotations = [];     // all annotations for the open document (all pages)
  var currentUserEmail = null;
  var LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  // ---- tie marks (M5) ----
  // A tie links two figures that should agree. Both ends can be on different
  // pages or even different documents, so a tie is stored as two endpoints and
  // rendered either as a connecting line (same page) or as numbered anchors
  // that jump to the other end.
  var allDocs = [];         // documents for the selected client (for titles/navigation)
  var ties = [];            // ties with at least one endpoint in the open document
  var pendingTie = null;    // first endpoint, waiting for the second click

  // ---- calculator tape (M6) ----
  // A manual adding machine: the reviewer keys figures in, watches the running
  // total, and stamps it onto the page. No OCR is involved — this captures the
  // footing WORKFLOW without pretending to read numbers off the document.
  var calcTape = [];        // [{ op: "+"|"-", value: Number }]
  var stampArmed = false;   // next page click drops the total

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
    currentUserEmail = email;
    loadClients();
  }

  // ---------- clients ----------
  async function loadClients() {
    var res = await sb.from("clients").select("slug,name,active").order("name");
    if (res.error) { console.error(res.error); return; }
    allClients = res.data || [];
    renderClientList();
  }

  // Filters by the search box and (by default) hides deactivated former
  // clients — with 120 clients, an unfiltered alphabetical list is unusable.
  function renderClientList() {
    var q = ($("#clientSearch").value || "").trim().toLowerCase();
    var showInactive = $("#showInactive").checked;
    var box = $("#clientList"); box.innerHTML = "";

    var list = allClients.filter(function (c) {
      if (!showInactive && !c.active) return false;
      if (!q) return true;
      return (c.name || "").toLowerCase().indexOf(q) !== -1;
    });

    list.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-item"; b.dataset.slug = c.slug;
      b.innerHTML = escapeHtml(c.name) + (c.active ? "" : ' <span class="rv-sub">(inactive)</span>');
      if (c.slug === selectedSlug) b.classList.add("active");
      b.addEventListener("click", function () { selectClient(c.slug, b); });
      box.appendChild(b);
    });

    var hiddenCount = allClients.length - list.length;
    $("#clientCount").textContent = list.length + " client" + (list.length === 1 ? "" : "s")
      + (hiddenCount > 0 ? " (" + hiddenCount + " hidden)" : "");
    if (!list.length) {
      box.innerHTML = '<div class="rv-sub" style="padding:8px 16px;color:var(--muted)">No matching clients.</div>';
    }
  }

  function selectClient(slug, btn) {
    selectedSlug = slug;
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
    allDocs = res.data || [];   // cached so tie anchors can name/navigate to their other end
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
    // NOTE: #rvEmpty lives inside #canvasWrap, which renderPage() clears via
    // innerHTML — so it does NOT exist after the first document is opened.
    // Guard it, or opening a SECOND document throws and silently aborts.
    var empty = $("#rvEmpty");
    if (empty) empty.hidden = true;

    setToolbarEnabled(false);
    $("#pageNum").textContent = "Loading…";
    try {
      var dl = await sb.storage.from("workpaper-docs").download(doc.storage_path);
      if (dl.error) throw new Error("Download failed: " + dl.error.message);
      var buf = await dl.data.arrayBuffer();
      var task = pdfjsLib.getDocument({ data: buf });
      var pdfDoc = await task.promise;
      state.pdfDoc = pdfDoc; state.pageNum = 1; state.pageCount = pdfDoc.numPages; state.docId = doc.id;
      setToolbarEnabled(true);
      setToolsEnabled(true);
      await loadAnnotations(doc.id);
      await loadTies(doc.id);
      await renderPage();
    } catch (err) {
      // Surface failures instead of leaving the viewer stuck on "Loading…"
      console.error("openDocument failed:", err);
      $("#pageNum").textContent = "Error";
      $("#toolHint").textContent = "Couldn't open that document: " + (err.message || err);
    }
  }

  // ---------- annotations ----------
  async function loadAnnotations(docId) {
    var res = await sb.from("annotations").select("*").eq("workpaper_document_id", docId);
    if (res.error) { console.error("load annotations:", res.error); annotations = []; return; }
    annotations = res.data || [];
  }

  function setToolsEnabled(on) {
    document.querySelectorAll(".tool-btn").forEach(function (b) { b.disabled = !on; });
    if (on && tool.type === "none") {
      $("#toolHint").textContent = "Pick a mark above, then click on the page to place it.";
    }
  }

  function setTool(type, symbol, btn) {
    tool.type = type; tool.symbol = symbol || null;
    document.querySelectorAll(".tool-btn").forEach(function (b) { b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
    var layer = $("#annoLayer");
    if (layer) layer.classList.toggle("placing", type !== "none");
    if (type !== "tie") cancelPendingTie();
    $("#toolHint").textContent = type === "none"
      ? "Select mode — click a mark to see who placed it, or delete it."
      : type === "note" ? "Click on the page to add a note."
      : type === "tie" ? "Click the first figure, then its match (you can switch pages or documents in between)."
      : "Click on the page to place " + tool.symbol + ".";
  }

  async function addAnnotation(xNorm, yNorm) {
    var row = {
      workpaper_document_id: state.docId,
      page: state.pageNum,
      x: xNorm, y: yNorm,
      type: tool.type,
      symbol: tool.type === "tic" ? tool.symbol : null,
      text: null,
      color: tool.type === "tic" ? "#c0392b" : null,
      created_by: currentUserEmail
    };
    if (tool.type === "note") {
      var noteText = window.prompt("Note:");
      if (noteText === null || !noteText.trim()) return;   // cancelled
      row.text = noteText.trim();
    }
    // Insert and read the row back so we have its real id for later deletion.
    var res = await sb.from("annotations").insert(row).select();
    if (res.error) { console.error("save annotation:", res.error); alert("Couldn't save that mark: " + res.error.message); return; }
    annotations.push((res.data && res.data[0]) || row);
    drawAnnotations();
  }

  // ---------- export annotated PDF (M7) ----------
  // Flattens every mark onto a copy of the original PDF and downloads it, so an
  // annotated workpaper can leave the tool (for a file, a reviewer, an auditor).
  //
  // Two things that bite here and are handled explicitly:
  //  1. pdf-lib's origin is BOTTOM-left; our stored coords are top-left
  //     normalized, so y must be flipped: pdfY = height * (1 - yNorm).
  //  2. The standard PDF fonts use WinAnsi encoding, which has NO glyph for
  //     ✓ or ✗ — drawText would throw. Those are drawn as vector strokes
  //     instead, and all user text is sanitised to WinAnsi-safe characters.
  function winAnsiSafe(s) {
    return String(s == null ? "" : s)
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—―]/g, "-")
      .replace(/…/g, "...")
      .replace(/ /g, " ")
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");   // drop anything else unencodable
  }

  function drawTic(page, symbol, x, y, color) {
    var s = 5;   // half-size of the mark in PDF points
    if (symbol === "✓") {
      page.drawLine({ start: { x: x - s, y: y }, end: { x: x - s * 0.2, y: y - s * 0.8 }, thickness: 1.4, color: color });
      page.drawLine({ start: { x: x - s * 0.2, y: y - s * 0.8 }, end: { x: x + s, y: y + s * 0.9 }, thickness: 1.4, color: color });
    } else if (symbol === "✗" || symbol === "x" || symbol === "X") {
      page.drawLine({ start: { x: x - s, y: y - s }, end: { x: x + s, y: y + s }, thickness: 1.4, color: color });
      page.drawLine({ start: { x: x - s, y: y + s }, end: { x: x + s, y: y - s }, thickness: 1.4, color: color });
    } else if (symbol === "•") {
      page.drawCircle({ x: x, y: y, size: 2.6, color: color });
    } else {
      return false;   // a letter — caller draws it as text
    }
    return true;
  }

  async function exportAnnotatedPdf() {
    if (!state.docId) { $("#toolHint").textContent = "Open a document first."; return; }
    var btn = $("#exportBtn");
    var origLabel = btn.textContent;
    btn.disabled = true; btn.textContent = "Exporting…";
    try {
      var doc = allDocs.filter(function (d) { return d.id === state.docId; })[0];
      var dl = await sb.storage.from("workpaper-docs").download(doc.storage_path);
      if (dl.error) throw new Error("Couldn't fetch the original: " + dl.error.message);
      var bytes = await dl.data.arrayBuffer();

      var pdf = await PDFDocument.load(bytes);
      var font = await pdf.embedFont(StandardFonts.Helvetica);
      var fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      var pages = pdf.getPages();
      var RED = rgb(0.75, 0.22, 0.17), NAVY = rgb(0.106, 0.165, 0.306),
          BLUE = rgb(0.114, 0.435, 0.847), AMBER = rgb(0.965, 0.765, 0.267);

      // --- point marks: tics, notes, calculator stamps ---
      annotations.forEach(function (a) {
        var pageIdx = Number(a.page) - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) return;
        var page = pages[pageIdx];
        var size = page.getSize();
        var x = Number(a.x) * size.width;
        var y = size.height * (1 - Number(a.y));   // flip: top-left -> bottom-left

        if (a.type === "tic") {
          if (!drawTic(page, a.symbol, x, y, RED)) {
            var letter = winAnsiSafe(a.symbol || "").slice(0, 2) || "A";
            page.drawText(letter, { x: x - 3, y: y - 4, size: 11, font: fontBold, color: RED });
          }
        } else if (a.type === "note") {
          page.drawRectangle({ x: x - 5, y: y - 5, width: 10, height: 10, color: AMBER,
            borderColor: rgb(0.79, 0.60, 0.12), borderWidth: 0.8 });
          var noteText = winAnsiSafe(a.text || "");
          if (noteText) {
            // keep it on-page: single line, clipped, placed to the right
            var maxChars = Math.max(10, Math.floor((size.width - x - 16) / 4.2));
            var shown = noteText.length > maxChars ? noteText.slice(0, maxChars - 1) + "…".replace("…", "...") : noteText;
            page.drawText(shown, { x: x + 9, y: y - 3, size: 7.5, font: font, color: NAVY });
          }
        } else if (a.type === "calc_stamp") {
          var total = winAnsiSafe(String(a.text || "").split("\n---\n")[0]);
          var w = font.widthOfTextAtSize(total, 9) + 8;
          page.drawRectangle({ x: x - w / 2, y: y - 7, width: w, height: 14,
            color: rgb(1, 1, 1), borderColor: NAVY, borderWidth: 0.8, opacity: 0.92 });
          page.drawText(total, { x: x - w / 2 + 4, y: y - 3, size: 9, font: fontBold, color: NAVY });
        }
      });

      // --- ties: numbered circles, plus a connecting line when both ends
      //     are on the same page of THIS document ---
      ties.forEach(function (t) {
        [["a", t.doc_a, t.page_a, t.x_a, t.y_a], ["b", t.doc_b, t.page_b, t.x_b, t.y_b]].forEach(function (end) {
          if (end[1] !== state.docId) return;
          var pageIdx = Number(end[2]) - 1;
          if (pageIdx < 0 || pageIdx >= pages.length) return;
          var page = pages[pageIdx];
          var size = page.getSize();
          var x = Number(end[3]) * size.width;
          var y = size.height * (1 - Number(end[4]));
          page.drawCircle({ x: x, y: y, size: 7, borderColor: BLUE, borderWidth: 1.2, color: rgb(1, 1, 1), opacity: 0.9 });
          var lbl = winAnsiSafe(t.label || "");
          if (lbl) {
            var lw = fontBold.widthOfTextAtSize(lbl, 7);
            page.drawText(lbl, { x: x - lw / 2, y: y - 2.5, size: 7, font: fontBold, color: BLUE });
          }
        });
        // connecting line only when both ends sit on the same page here
        if (t.doc_a === state.docId && t.doc_b === state.docId && Number(t.page_a) === Number(t.page_b)) {
          var pi = Number(t.page_a) - 1;
          if (pi < 0 || pi >= pages.length) return;
          var p = pages[pi]; var sz = p.getSize();
          p.drawLine({
            start: { x: Number(t.x_a) * sz.width, y: sz.height * (1 - Number(t.y_a)) },
            end: { x: Number(t.x_b) * sz.width, y: sz.height * (1 - Number(t.y_b)) },
            thickness: 0.9, color: BLUE, opacity: 0.85
          });
        }
      });

      // --- footer on page 1 so the export is self-describing ---
      var p1 = pages[0], p1s = p1.getSize();
      var stamp = winAnsiSafe("Reviewed in WWC Workpaper Review - " + (currentUserEmail || "") + " - " + new Date().toLocaleString());
      p1.drawText(stamp, { x: 18, y: 12, size: 6.5, font: font, color: rgb(0.45, 0.47, 0.53) });

      var out = await pdf.save();
      var blob = new Blob([out], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (doc.title || "document").replace(/[\\/:*?"<>|]/g, "-") + " (annotated).pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

      var markCount = annotations.length + ties.filter(function (t) { return t.doc_a === state.docId || t.doc_b === state.docId; }).length;
      $("#toolHint").textContent = "Exported with " + markCount + " mark" + (markCount === 1 ? "" : "s") + ".";
    } catch (err) {
      console.error("export failed:", err);
      $("#toolHint").textContent = "Export failed: " + (err.message || err);
    }
    btn.disabled = false; btn.textContent = origLabel;
  }

  // ---------- calculator tape ----------
  function fmtMoney(n) {
    return (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function calcTotal() {
    return calcTape.reduce(function (acc, e) {
      if (e.op === "-") return acc - e.value;
      if (e.op === "×") return acc * e.value;
      if (e.op === "÷") return e.value === 0 ? acc : acc / e.value;   // guarded upstream too
      return acc + e.value;
    }, 0);
  }

  // Safe arithmetic evaluator — recursive descent over + - * / ( ) with a
  // trailing % meaning "/100". Deliberately NOT eval(): this parses a fixed
  // grammar and can't execute anything. Lets a reviewer type "1200*0.65" or
  // "(4200+800)/12" straight into the tape.
  function parseFigure(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim().replace(/[$,\s]/g, "").replace(/×/g, "*").replace(/÷/g, "/");
    if (!s) return NaN;
    // accounting negatives: (500) -> -500, but only when it wraps the whole input
    if (/^\([^()]*\)$/.test(s) && !/[+\-*/]/.test(s.slice(1, -1))) s = "-" + s.slice(1, -1);
    if (!/^[0-9.+\-*/()%]+$/.test(s)) return NaN;

    var i = 0;
    function peek() { return s[i]; }
    function expr() {
      var v = term();
      while (peek() === "+" || peek() === "-") { var op = s[i++]; var r = term(); if (isNaN(r)) return NaN; v = op === "+" ? v + r : v - r; }
      return v;
    }
    function term() {
      var v = factor();
      while (peek() === "*" || peek() === "/") {
        var op = s[i++]; var r = factor();
        if (isNaN(r)) return NaN;
        if (op === "/" && r === 0) return NaN;    // division by zero -> invalid, not Infinity
        v = op === "*" ? v * r : v / r;
      }
      return v;
    }
    function factor() {
      if (peek() === "-") { i++; var n = factor(); return isNaN(n) ? NaN : -n; }
      if (peek() === "+") { i++; return factor(); }
      var v;
      if (peek() === "(") {
        i++; v = expr();
        if (peek() !== ")") return NaN;
        i++;
      } else {
        var start = i;
        while (i < s.length && /[0-9.]/.test(s[i])) i++;
        if (i === start) return NaN;
        var numStr = s.slice(start, i);
        if ((numStr.match(/\./g) || []).length > 1) return NaN;
        v = parseFloat(numStr);
      }
      while (peek() === "%") { i++; v = v / 100; }   // 7.5% -> 0.075
      return v;
    }

    var out = expr();
    if (i !== s.length || isNaN(out) || !isFinite(out)) return NaN;
    return out;
  }
  function renderCalc() {
    var tape = $("#calcTape");
    if (!calcTape.length) {
      tape.innerHTML = '<div class="rv-calc-empty">Enter figures to foot a column.</div>';
    } else {
      tape.innerHTML = "";
      calcTape.forEach(function (e) {
        var row = document.createElement("div");
        row.className = "rv-calc-row";
        row.innerHTML = '<span class="op">' + e.op + "</span><span>" + fmtMoney(e.value) + "</span>";
        tape.appendChild(row);
      });
      tape.scrollTop = tape.scrollHeight;
    }
    $("#calcTotal").textContent = fmtMoney(calcTotal());
  }
  function calcPush(op) {
    var n = parseFigure($("#calcInput").value);
    if (isNaN(n)) { flashCalcError(); return; }
    if (op === "÷" && n === 0) { flashCalcError("Can't divide by zero"); return; }

    if (op === "+" || op === "-") {
      // a typed negative already means subtract; don't negate twice
      if (n < 0) calcTape.push({ op: "-", value: Math.abs(n) });
      else calcTape.push({ op: op, value: n });
    } else {
      // × and ÷ apply to the running total (adding-machine behaviour)
      calcTape.push({ op: op, value: n });
    }
    $("#calcInput").value = "";
    $("#calcInput").focus();
    renderCalc();
  }

  function flashCalcError(msg) {
    var el = $("#calcInput");
    el.style.borderColor = "#c0392b";
    el.select();
    if (msg) $("#toolHint").textContent = msg;
    setTimeout(function () { el.style.borderColor = ""; }, 900);
  }
  function setStampArmed(on) {
    stampArmed = on;
    $("#calcStamp").classList.toggle("armed", on);
    $("#calcStamp").textContent = on ? "Click the page…" : "Stamp total";
    var layer = $("#annoLayer");
    if (layer) layer.classList.toggle("placing", on || tool.type !== "none");
    if (on) $("#toolHint").textContent = "Click on the page to stamp " + fmtMoney(calcTotal()) + ". (Esc to cancel)";
  }
  async function stampTotal(xNorm, yNorm) {
    var total = calcTotal();
    // Keep the tape with the stamp so the figure is auditable later: first line
    // is what's drawn on the page, the rest shows how it was computed.
    var detail = calcTape.map(function (e) { return e.op + " " + fmtMoney(e.value); }).join("\n");
    var row = {
      workpaper_document_id: state.docId,
      page: state.pageNum,
      x: xNorm, y: yNorm,
      type: "calc_stamp",
      symbol: null,
      text: fmtMoney(total) + (detail ? "\n---\n" + detail : ""),
      color: "#1B2A4E",
      created_by: currentUserEmail
    };
    var res = await sb.from("annotations").insert(row).select();
    if (res.error) { console.error("stamp:", res.error); alert("Couldn't stamp that total: " + res.error.message); return; }
    annotations.push((res.data && res.data[0]) || row);
    setStampArmed(false);
    $("#toolHint").textContent = "Total stamped.";
    drawAnnotations();
  }

  // ---------- tie marks ----------
  async function loadTies(docId) {
    // a tie is relevant if EITHER endpoint is in this document
    var res = await sb.from("ties").select("*").or("doc_a.eq." + docId + ",doc_b.eq." + docId);
    if (res.error) { console.error("load ties:", res.error); ties = []; return; }
    ties = res.data || [];
  }

  function docTitle(docId) {
    var d = allDocs.filter(function (x) { return x.id === docId; })[0];
    return d ? d.title : "another document";
  }

  function nextTieLabel() {
    var nums = ties.map(function (t) { return parseInt(t.label, 10); }).filter(function (n) { return !isNaN(n); });
    return String((nums.length ? Math.max.apply(null, nums) : 0) + 1);
  }

  async function handleTieClick(xNorm, yNorm) {
    if (!pendingTie) {
      pendingTie = { docId: state.docId, page: state.pageNum, x: xNorm, y: yNorm };
      $("#toolHint").textContent = "First point set. Now click the matching figure — you can switch pages or documents first. (Esc to cancel)";
      drawAnnotations();
      return;
    }
    // second click completes the tie
    var row = {
      doc_a: pendingTie.docId, page_a: pendingTie.page, x_a: pendingTie.x, y_a: pendingTie.y,
      doc_b: state.docId, page_b: state.pageNum, x_b: xNorm, y_b: yNorm,
      label: nextTieLabel(), color: "#1d6fd8", created_by: currentUserEmail
    };
    var res = await sb.from("ties").insert(row).select();
    if (res.error) { console.error("save tie:", res.error); alert("Couldn't save that tie: " + res.error.message); pendingTie = null; return; }
    ties.push((res.data && res.data[0]) || row);
    pendingTie = null;
    $("#toolHint").textContent = "Tie created. Click another figure to start the next tie.";
    drawAnnotations();
  }

  function cancelPendingTie() {
    if (!pendingTie) return;
    pendingTie = null;
    $("#toolHint").textContent = "Tie cancelled. Click a figure to start a new tie.";
    drawAnnotations();
  }

  async function deleteTie(id) {
    var res = await sb.from("ties").delete().eq("id", id);
    if (res.error) { console.error("delete tie:", res.error); return; }
    ties = ties.filter(function (t) { return t.id !== id; });
    drawAnnotations();
  }

  // Draws ties for the current page: a connecting line when both ends are on
  // this page, otherwise a numbered anchor that navigates to the other end.
  function drawTies(layer) {
    var here = function (docId, page) { return docId === state.docId && Number(page) === state.pageNum; };

    // SVG layer for connecting lines (only needed for same-page ties)
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "rv-tie-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    layer.appendChild(svg);

    ties.forEach(function (t) {
      var aHere = here(t.doc_a, t.page_a), bHere = here(t.doc_b, t.page_b);
      if (!aHere && !bHere) return;

      if (aHere && bHere) {
        var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", Number(t.x_a) * 100); line.setAttribute("y1", Number(t.y_a) * 100);
        line.setAttribute("x2", Number(t.x_b) * 100); line.setAttribute("y2", Number(t.y_b) * 100);
        line.setAttribute("stroke", t.color || "#1d6fd8");
        line.setAttribute("stroke-width", "0.35");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(line);
      }

      // an anchor for each endpoint that's on this page
      [["a", aHere], ["b", bHere]].forEach(function (pair) {
        if (!pair[1]) return;
        var side = pair[0];
        var otherDoc = side === "a" ? t.doc_b : t.doc_a;
        var otherPage = side === "a" ? t.page_b : t.page_a;
        var sameSpot = aHere && bHere;

        var el = document.createElement("div");
        el.className = "anno tie" + (sameSpot ? " tie-linked" : "");
        el.style.left = (Number(side === "a" ? t.x_a : t.x_b) * 100) + "%";
        el.style.top = (Number(side === "a" ? t.y_a : t.y_b) * 100) + "%";
        el.style.borderColor = t.color || "#1d6fd8";
        el.style.color = t.color || "#1d6fd8";
        el.textContent = t.label || "•";

        var tipText = "Tie " + (t.label || "") + "\n"
          + (sameSpot ? "Both ends on this page."
                      : "Other end: " + docTitle(otherDoc) + " (p." + otherPage + ") — click to jump")
          + "\n— " + (t.created_by || "unknown")
          + (t.created_at ? "\n" + new Date(t.created_at).toLocaleString() : "");
        el.addEventListener("mouseenter", function () { showTip(el, tipText); });
        el.addEventListener("mouseleave", hideTip);
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          if (!sameSpot) { jumpToTieEnd(otherDoc, otherPage); return; }
          if (t.id && window.confirm("Delete tie " + t.label + "?")) deleteTie(t.id);
        });
        el.addEventListener("contextmenu", function (e) {
          e.preventDefault(); e.stopPropagation();
          if (t.id && window.confirm("Delete tie " + t.label + "?")) deleteTie(t.id);
        });
        layer.appendChild(el);
      });
    });

    // show the half-finished tie so it's obvious one is in progress
    if (pendingTie && pendingTie.docId === state.docId && pendingTie.page === state.pageNum) {
      var p = document.createElement("div");
      p.className = "anno tie tie-pending";
      p.style.left = (pendingTie.x * 100) + "%";
      p.style.top = (pendingTie.y * 100) + "%";
      p.textContent = "?";
      layer.appendChild(p);
    }
  }

  async function jumpToTieEnd(docId, page) {
    var target = allDocs.filter(function (d) { return d.id === docId; })[0];
    if (!target) { alert("That document isn't in this client's list."); return; }
    if (docId === state.docId) { state.pageNum = Number(page); await renderPage(); return; }
    // highlight it in the sidebar too, so the UI stays truthful about what's open
    var btns = Array.prototype.slice.call(document.querySelectorAll("#docList .rv-item"));
    btns.forEach(function (b) { b.classList.remove("active"); });
    var match = btns.filter(function (b) { return b.textContent.indexOf(target.title) === 0; })[0];
    if (match) match.classList.add("active");
    await openDocument(target);
    state.pageNum = Number(page);
    await renderPage();
  }

  async function deleteAnnotation(id) {
    var res = await sb.from("annotations").delete().eq("id", id);
    if (res.error) { console.error("delete annotation:", res.error); return; }
    annotations = annotations.filter(function (a) { return a.id !== id; });
    drawAnnotations();
  }

  // Renders the marks for the CURRENT page onto the overlay, positioned by
  // their normalized coords so they track the canvas at any zoom.
  function drawAnnotations() {
    var layer = $("#annoLayer");
    if (!layer) return;
    layer.innerHTML = "";
    drawTies(layer);
    annotations.filter(function (a) { return Number(a.page) === state.pageNum; }).forEach(function (a) {
      var el = document.createElement("div");
      el.className = "anno " + a.type;
      el.style.left = (Number(a.x) * 100) + "%";
      el.style.top = (Number(a.y) * 100) + "%";
      // calc stamps store "total\n---\ntape detail": show the total, keep the
      // working in the tooltip so a stamped figure stays auditable.
      var stampTotalText = "", stampDetail = "";
      if (a.type === "calc_stamp") {
        var parts = String(a.text || "").split("\n---\n");
        stampTotalText = parts[0]; stampDetail = parts[1] || "";
      }

      if (a.type === "tic") { el.textContent = a.symbol || "✓"; el.style.color = a.color || "#c0392b"; }
      else if (a.type === "calc_stamp") { el.textContent = stampTotalText; }
      // note renders as the yellow square from CSS

      var tipText = (a.type === "note" && a.text ? a.text + "\n\n" : "")
        + (a.type === "calc_stamp" && stampDetail ? "Footed:\n" + stampDetail + "\n\n" : "")
        + "— " + (a.created_by || "unknown")
        + (a.created_at ? "\n" + new Date(a.created_at).toLocaleString() : "");
      el.addEventListener("mouseenter", function () { showTip(el, tipText); });
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", function (e) {
        e.stopPropagation();   // don't also place a new mark underneath
        if (a.id && window.confirm("Delete this mark?\n\n" + tipText)) deleteAnnotation(a.id);
      });
      layer.appendChild(el);
    });
  }

  function showTip(anchorEl, text) {
    hideTip();
    var tip = document.createElement("div");
    tip.className = "anno-tip"; tip.id = "annoTip"; tip.textContent = text;
    tip.style.left = anchorEl.style.left; tip.style.top = anchorEl.style.top;
    anchorEl.parentNode.appendChild(tip);
  }
  function hideTip() { var t = document.getElementById("annoTip"); if (t) t.remove(); }

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

    // Overlay for marks — sits exactly on the canvas, so a click's position
    // converts cleanly to normalized page coords regardless of zoom.
    var layer = document.createElement("div");
    layer.className = "rv-anno-layer" + (tool.type !== "none" ? " placing" : "");
    layer.id = "annoLayer";
    layer.addEventListener("click", function (e) {
      if (tool.type === "none" && !stampArmed) return;
      var rect = layer.getBoundingClientRect();
      var xNorm = (e.clientX - rect.left) / rect.width;
      var yNorm = (e.clientY - rect.top) / rect.height;
      if (xNorm < 0 || xNorm > 1 || yNorm < 0 || yNorm > 1) return;
      if (stampArmed) { stampTotal(xNorm, yNorm); return; }   // stamping wins over the active mark tool
      if (tool.type === "tie") { handleTieClick(xNorm, yNorm); return; }
      addAnnotation(xNorm, yNorm);
    });
    shell.appendChild(layer);
    drawAnnotations();

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
    $("#clientSearch").addEventListener("input", renderClientList);
    $("#showInactive").addEventListener("change", renderClientList);
    // Esc abandons a half-finished tie or a primed stamp
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      cancelPendingTie();
      if (stampArmed) { setStampArmed(false); $("#toolHint").textContent = "Stamp cancelled."; }
    });

    // ---- calculator tape ----
    $("#calcToggle").addEventListener("click", function () {
      var panel = $("#calcPanel");
      panel.hidden = !panel.hidden;
      $("#calcToggle").classList.toggle("active", !panel.hidden);
      if (!panel.hidden) { renderCalc(); $("#calcInput").focus(); }
      else if (stampArmed) setStampArmed(false);
    });
    $("#calcClose").addEventListener("click", function () {
      $("#calcPanel").hidden = true;
      $("#calcToggle").classList.remove("active");
      if (stampArmed) setStampArmed(false);
    });
    $("#calcAdd").addEventListener("click", function () { calcPush("+"); });
    $("#calcSub").addEventListener("click", function () { calcPush("-"); });
    $("#calcMul").addEventListener("click", function () { calcPush("×"); });
    $("#calcDiv").addEventListener("click", function () { calcPush("÷"); });
    $("#calcUndo").addEventListener("click", function () { calcTape.pop(); renderCalc(); $("#calcInput").focus(); });
    $("#calcClear").addEventListener("click", function () { calcTape = []; renderCalc(); $("#calcInput").focus(); });
    $("#calcInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); calcPush("+"); }
      if (e.key === "-" && !$("#calcInput").value) { /* let a leading minus type normally */ }
    });
    $("#exportBtn").addEventListener("click", exportAnnotatedPdf);
    $("#calcStamp").addEventListener("click", function () {
      if (!state.docId) { $("#toolHint").textContent = "Open a document first."; return; }
      setStampArmed(!stampArmed);
    });

    // Annotation toolbar: pick a mark, then click the page to place it.
    document.querySelectorAll(".tool-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.dataset.tool;
        // Export and the calculator toggle share the .tool-btn class for styling
        // but aren't mark tools — without this they'd fall through and arm a
        // "tic" tool with an undefined symbol.
        if (!type) return;
        if (type === "none") { setTool("none", null, btn); return; }
        if (type === "note") { setTool("note", null, btn); return; }
        if (type === "tie") { setTool("tie", null, btn); return; }
        var sym = btn.dataset.symbol;
        // The letter button cycles A→B→C… on repeat clicks while already active.
        if (LETTERS.indexOf(sym) !== -1 && btn.classList.contains("active")) {
          var next = LETTERS[(LETTERS.indexOf(sym) + 1) % LETTERS.length];
          btn.dataset.symbol = next; btn.textContent = next; sym = next;
        }
        setTool("tic", sym, btn);
      });
    });

    $("#prevPage").addEventListener("click", function () { if (state.pageNum > 1) { state.pageNum--; renderPage(); } });
    $("#nextPage").addEventListener("click", function () { if (state.pageNum < state.pageCount) { state.pageNum++; renderPage(); } });
    $("#zoomOut").addEventListener("click", function () { if (state.scaleIdx > 0) { state.scaleIdx--; renderPage(); } });
    $("#zoomIn").addEventListener("click", function () { if (state.scaleIdx < SCALES.length - 1) { state.scaleIdx++; renderPage(); } });

    boot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
