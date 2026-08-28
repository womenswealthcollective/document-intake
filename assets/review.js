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

  // ---------- calculator tape ----------
  function fmtMoney(n) {
    return (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function calcTotal() {
    return calcTape.reduce(function (sum, e) { return e.op === "-" ? sum - e.value : sum + e.value; }, 0);
  }
  function parseFigure(raw) {
    if (raw == null) return NaN;
    // tolerate "1,234.56", "$1,234.56", "(500)" for negatives, stray spaces
    var s = String(raw).trim().replace(/[$,\s]/g, "");
    var neg = /^\(.*\)$/.test(s);
    if (neg) s = s.slice(1, -1);
    if (!s || !/^-?\d*\.?\d+$/.test(s)) return NaN;
    var n = parseFloat(s);
    return neg ? -n : n;
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
    if (isNaN(n)) { $("#calcInput").select(); return; }
    // a typed leading "-" already means subtract; don't negate twice
    if (n < 0 && op === "-") { calcTape.push({ op: "-", value: Math.abs(n) }); }
    else if (n < 0) { calcTape.push({ op: "-", value: Math.abs(n) }); }
    else { calcTape.push({ op: op, value: n }); }
    $("#calcInput").value = "";
    $("#calcInput").focus();
    renderCalc();
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
    $("#calcUndo").addEventListener("click", function () { calcTape.pop(); renderCalc(); $("#calcInput").focus(); });
    $("#calcClear").addEventListener("click", function () { calcTape = []; renderCalc(); $("#calcInput").focus(); });
    $("#calcInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); calcPush("+"); }
      if (e.key === "-" && !$("#calcInput").value) { /* let a leading minus type normally */ }
    });
    $("#calcStamp").addEventListener("click", function () {
      if (!state.docId) { $("#toolHint").textContent = "Open a document first."; return; }
      setStampArmed(!stampArmed);
    });

    // Annotation toolbar: pick a mark, then click the page to place it.
    document.querySelectorAll(".tool-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.dataset.tool;
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
