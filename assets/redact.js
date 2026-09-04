/* PII Redaction — standalone, fully client-side.
   The PDF is never uploaded: it's read with FileReader, rendered locally, and
   the redacted copy is generated in-browser and downloaded.

   WHY RASTERISE: drawing a black rectangle over text does NOT remove it — the
   text stays in the content stream and comes straight back out with copy/paste
   or any text extractor. This is how real-world redaction failures happen. So
   each page is rendered to a canvas, the boxes are painted onto the PIXELS, and
   the output PDF is rebuilt from those images. The text layer is destroyed, so
   there is nothing left to recover. */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";

// Cross-origin workers are blocked by browsers, so load it via a same-origin blob.
const workerBlobUrl = await fetch("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs")
  .then((r) => r.text())
  .then((t) => URL.createObjectURL(new Blob([t], { type: "application/javascript" })));

(function () {
  "use strict";
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

  var $ = function (s) { return document.querySelector(s); };
  var RENDER_SCALE = 2;          // 2x for legible output
  var PAD = 1.6;                 // grow each box slightly so glyph edges are covered

  var pdfDoc = null, fileName = "document.pdf", pageNum = 1, pageCount = 0;
  var hits = [];                 // detected PII, all pages
  var manual = [];               // user-drawn boxes, all pages
  var srcBytes = null;

  // --- detectors -----------------------------------------------------------
  // Deliberately a little greedy: every hit is shown for confirmation before
  // anything is removed, so a false positive costs a click, while a miss could
  // ship a client's SSN.
  var DETECTORS = [
    { key: "ssn",  label: "SSN / ITIN",              re: /\b\d{3}-\d{2}-\d{4}\b/g,  on: true },
    { key: "ein",  label: "EIN",                     re: /\b\d{2}-\d{7}\b/g,        on: true },
    { key: "acct", label: "Account / routing no.",   re: /\b\d{8,17}\b/g,           on: true }
  ];

  function detectIn(text) {
    var out = [];
    DETECTORS.forEach(function (d) {
      d.re.lastIndex = 0;
      var m;
      while ((m = d.re.exec(text)) !== null) {
        // already-masked values (***-**-1234) never match the digit patterns,
        // so anything found here is a real, exposed identifier
        out.push({ key: d.key, label: d.label, value: m[0], start: m.index, end: m.index + m[0].length });
      }
    });
    return out;
  }

  // --- load ---------------------------------------------------------------
  async function loadFile(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      $("#loadMsg").textContent = "That doesn't look like a PDF.";
      return;
    }
    fileName = file.name;
    $("#loadMsg").textContent = "Reading " + file.name + "…";
    try {
      srcBytes = await file.arrayBuffer();
      // pdf.js transfers/detaches the buffer it's given, so hand it a copy and
      // keep srcBytes intact for the rebuild step.
      pdfDoc = await pdfjsLib.getDocument({ data: srcBytes.slice(0) }).promise;
      pageCount = pdfDoc.numPages;
      pageNum = 1;
      hits = []; manual = [];
      $("#fileLbl").textContent = file.name + " · " + pageCount + " page" + (pageCount === 1 ? "" : "s");
      $("#dropCard").hidden = true;
      $("#work").hidden = false;
      await scanAll();
      await renderPage();
    } catch (e) {
      console.error(e);
      $("#loadMsg").textContent = "Couldn't open that PDF: " + (e.message || e);
    }
  }

  // --- scan every page for PII, recording positions ------------------------
  async function scanAll() {
    $("#scanMsg").textContent = "Scanning " + pageCount + " page" + (pageCount === 1 ? "" : "s") + "…";
    var found = [];
    for (var p = 1; p <= pageCount; p++) {
      var page = await pdfDoc.getPage(p);
      var viewport = page.getViewport({ scale: RENDER_SCALE });
      var tc = await page.getTextContent();
      tc.items.forEach(function (item) {
        if (!item.str) return;
        var matches = detectIn(item.str);
        if (!matches.length) return;
        // Map the text item into viewport space. Character-level boxes aren't
        // available, so approximate horizontally within the item's own width.
        var tr = pdfjsLib.Util.transform(viewport.transform, item.transform);
        var itemW = (item.width || 0) * RENDER_SCALE;
        var itemH = (item.height || 10) * RENDER_SCALE;
        var x0 = tr[4], yTop = tr[5] - itemH;
        var perChar = item.str.length ? itemW / item.str.length : itemW;
        matches.forEach(function (m) {
          found.push({
            page: p, key: m.key, label: m.label, value: m.value, on: true,
            x: x0 + perChar * m.start - PAD,
            y: yTop - PAD,
            w: perChar * (m.end - m.start) + PAD * 2,
            h: itemH + PAD * 2
          });
        });
      });
    }
    hits = found;
    renderGroups();
    var scanned = hits.length;
    $("#scanMsg").textContent = scanned
      ? scanned + " potential identifier" + (scanned === 1 ? "" : "s") + " found. Confirm before redacting."
      : "No SSN/EIN/account patterns found in the text layer. If this is a scanned document it has no searchable text — drag boxes on the page instead.";
    updateCount();
  }

  function renderGroups() {
    var box = $("#groups"); box.innerHTML = "";
    DETECTORS.forEach(function (d) {
      var mine = hits.filter(function (h) { return h.key === d.key; });
      var g = document.createElement("div");
      g.className = "rd-group";
      var lab = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = mine.some(function (h) { return h.on; }); cb.disabled = !mine.length;
      cb.addEventListener("change", function () {
        mine.forEach(function (h) { h.on = cb.checked; });
        renderPage(); updateCount();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(d.label));
      var cnt = document.createElement("span");
      cnt.className = "cnt"; cnt.textContent = mine.length;
      lab.appendChild(cnt);
      g.appendChild(lab);

      if (mine.length) {
        var list = document.createElement("div"); list.className = "rd-list";
        mine.forEach(function (h) {
          var row = document.createElement("div"); row.className = "rd-item";
          var c = document.createElement("input");
          c.type = "checkbox"; c.checked = h.on;
          c.addEventListener("change", function () { h.on = c.checked; renderPage(); updateCount(); renderGroups(); });
          row.appendChild(c);
          row.appendChild(document.createTextNode(h.value));
          var pg = document.createElement("span"); pg.className = "pg"; pg.textContent = "p." + h.page;
          pg.style.cursor = "pointer";
          pg.addEventListener("click", function () { pageNum = h.page; renderPage(); });
          row.appendChild(pg);
          list.appendChild(row);
        });
        g.appendChild(list);
      }
      box.appendChild(g);
    });
  }

  function selected() {
    return hits.filter(function (h) { return h.on; }).length + manual.length;
  }
  function updateCount() {
    var n = selected();
    $("#selCount").textContent = n + " area" + (n === 1 ? "" : "s");
    $("#redactBtn").disabled = n === 0;
  }

  // --- render current page + boxes ----------------------------------------
  async function renderPage() {
    if (!pdfDoc) return;
    var page = await pdfDoc.getPage(pageNum);
    var viewport = page.getViewport({ scale: RENDER_SCALE });
    var stage = $("#stage"); stage.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "rd-pagewrap";
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";
    var canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    wrap.appendChild(canvas);

    var overlay = document.createElement("div");
    overlay.className = "rd-overlay";
    wrap.appendChild(overlay);
    stage.appendChild(wrap);

    var task = page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport });
    task.onContinue = function (c) { c(); };   // some embedded browsers never fire the default continuation
    await task.promise;

    hits.filter(function (h) { return h.page === pageNum; }).forEach(function (h) {
      var el = document.createElement("div");
      el.className = "rd-hit" + (h.on ? " on" : "");
      el.style.left = h.x + "px"; el.style.top = h.y + "px";
      el.style.width = h.w + "px"; el.style.height = h.h + "px";
      el.title = (h.on ? "Will be removed: " : "Left visible: ") + h.value + " — click to toggle";
      el.addEventListener("click", function (e) {
        e.stopPropagation(); h.on = !h.on; renderPage(); updateCount(); renderGroups();
      });
      overlay.appendChild(el);
    });

    manual.filter(function (m) { return m.page === pageNum; }).forEach(function (m) {
      var el = document.createElement("div");
      el.className = "rd-manual";
      el.style.left = m.x + "px"; el.style.top = m.y + "px";
      el.style.width = m.w + "px"; el.style.height = m.h + "px";
      el.title = "Your box — click to remove";
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        manual.splice(manual.indexOf(m), 1);
        renderPage(); updateCount();
      });
      overlay.appendChild(el);
    });

    enableDrawing(overlay);
    $("#pageLbl").textContent = "Page " + pageNum + " of " + pageCount;
    $("#prev").disabled = pageNum <= 1;
    $("#next").disabled = pageNum >= pageCount;
  }

  // drag to add your own box (essential for scans, which have no text layer)
  function enableDrawing(overlay) {
    var startX = 0, startY = 0, ghost = null, drawing = false;
    overlay.addEventListener("mousedown", function (e) {
      if (e.target !== overlay) return;   // clicking an existing box toggles it instead
      var r = overlay.getBoundingClientRect();
      startX = e.clientX - r.left; startY = e.clientY - r.top;
      drawing = true;
      ghost = document.createElement("div");
      ghost.className = "rd-drag";
      overlay.appendChild(ghost);
    });
    overlay.addEventListener("mousemove", function (e) {
      if (!drawing) return;
      var r = overlay.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      ghost.style.left = Math.min(startX, x) + "px";
      ghost.style.top = Math.min(startY, y) + "px";
      ghost.style.width = Math.abs(x - startX) + "px";
      ghost.style.height = Math.abs(y - startY) + "px";
    });
    window.addEventListener("mouseup", function (e) {
      if (!drawing) return;
      drawing = false;
      var r = overlay.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      var box = {
        page: pageNum,
        x: Math.min(startX, x), y: Math.min(startY, y),
        w: Math.abs(x - startX), h: Math.abs(y - startY)
      };
      if (ghost) { ghost.remove(); ghost = null; }
      if (box.w > 4 && box.h > 4) { manual.push(box); renderPage(); updateCount(); }
    });
  }

  // --- produce the redacted PDF -------------------------------------------
  async function redact() {
    var btn = $("#redactBtn"), label = btn.textContent;
    btn.disabled = true; btn.textContent = "Redacting…";
    $("#outMsg").textContent = "";
    try {
      var out = await PDFDocument.create();
      for (var p = 1; p <= pageCount; p++) {
        $("#outMsg").textContent = "Flattening page " + p + " of " + pageCount + "…";
        var page = await pdfDoc.getPage(p);
        var viewport = page.getViewport({ scale: RENDER_SCALE });
        var canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        var ctx = canvas.getContext("2d");
        var task = page.render({ canvasContext: ctx, viewport: viewport });
        task.onContinue = function (c) { c(); };
        await task.promise;

        // paint the boxes onto the PIXELS — this is what makes it permanent
        ctx.fillStyle = "#000";
        hits.filter(function (h) { return h.page === p && h.on; })
            .forEach(function (h) { ctx.fillRect(h.x, h.y, h.w, h.h); });
        manual.filter(function (m) { return m.page === p; })
              .forEach(function (m) { ctx.fillRect(m.x, m.y, m.w, m.h); });

        var jpg = canvas.toDataURL("image/jpeg", 0.92);
        var img = await out.embedJpg(jpg);
        // keep the original page size so print/scale behaviour is unchanged
        var orig = page.getViewport({ scale: 1 });
        var pg = out.addPage([orig.width, orig.height]);
        pg.drawImage(img, { x: 0, y: 0, width: orig.width, height: orig.height });
      }

      var bytes = await out.save();
      var blob = new Blob([bytes], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = fileName.replace(/\.pdf$/i, "") + " (redacted).pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

      var n = selected();
      $("#outMsg").textContent = "Done — " + n + " area" + (n === 1 ? "" : "s")
        + " removed across " + pageCount + " page" + (pageCount === 1 ? "" : "s") + ". Text layer destroyed.";
    } catch (e) {
      console.error(e);
      $("#outMsg").textContent = "Redaction failed: " + (e.message || e);
    }
    btn.disabled = false; btn.textContent = label;
  }

  // --- wiring -------------------------------------------------------------
  function init() {
    var drop = $("#drop"), input = $("#file");
    drop.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () { loadFile(input.files[0]); });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    $("#prev").addEventListener("click", function () { if (pageNum > 1) { pageNum--; renderPage(); } });
    $("#next").addEventListener("click", function () { if (pageNum < pageCount) { pageNum++; renderPage(); } });
    $("#redactBtn").addEventListener("click", redact);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
