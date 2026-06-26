/* 小钻风阅读器 — front-end logic.
   Renders each daily deck in a same-origin iframe, reflowed to vertical scroll
   (template-agnostic: we neutralise the fixed 16:9 stage and strip the deck's
   own scripts). Selection → floating toolbar → 5 actions, all backed by the
   local CC server. Annotations are text-quote anchored so they survive reloads. */

const REFLOW_CSS = `
  html,body{width:1920px!important;height:auto!important;overflow:visible!important;background:#fff!important;margin:0!important;}
  .deck-viewport{position:static!important;overflow:visible!important;background:#fff!important;inset:auto!important;}
  .deck-stage{position:static!important;width:auto!important;height:auto!important;transform:none!important;background:none!important;}
  .slide{position:relative!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;
         width:1920px!important;height:auto!important;min-height:1040px!important;display:block!important;
         transform:none!important;left:auto!important;top:auto!important;inset:auto!important;
         border-bottom:3px solid #e2ddd4!important;}
  .pad{position:static!important;inset:auto!important;height:auto!important;min-height:980px!important;}
  .reveal,[class*="reveal"]{opacity:1!important;transform:none!important;filter:none!important;}
  .xzf-anno{border-radius:3px;padding:0 1px;cursor:pointer;transition:outline .1s;}
  .xzf-note{background:#FBE7A1;} .xzf-tag{background:#CDE7C9;} .xzf-term{background:#D6E4F5;}
  .xzf-ask{background:#F6D3C6;} .xzf-translate{background:#e7ddf5;}
  .xzf-anno:hover,.xzf-flash{outline:2px solid var(--vermilion,#B5252B);}
`;

const $ = (s) => document.querySelector(s);
const state = { date: null, graph: null, postBySlide: {}, sel: null, decks: [], dpMonth: null };

const api = {
  get: (u) => fetch(u).then((r) => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
};
const setStatus = (t) => { $("#status").textContent = t || ""; };

// ----------------------------------------------------------------- bootstrap
async function boot() {
  const { decks } = await api.get("/api/reader/decks");
  state.decks = decks;
  bindDatepicker();
  $("#btn-extract").onclick = extractCurrent;
  $("#btn-upload").onclick = () => $("#file-deck").click();
  $("#file-deck").onchange = uploadDeck;
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  bindToolbar();
  bindDivider();
  const at = $("#auto-tx");
  at.checked = localStorage.getItem("xzf-autotx") !== "0";
  at.onchange = () => localStorage.setItem("xzf-autotx", at.checked ? "1" : "0");
  window.addEventListener("resize", fitDeck);
  checkTx();
  if (decks.length) loadDeck(decks[0].date);
  else $("#reading").innerHTML = "<p style='margin:auto;color:#888'>还没有导读。把每天的 HTML 丢进 data/reader/decks/ 即可。</p>";
}

// ----------------------------------------------- coupling: 存进手帐 + 翻译模型
// turn any reader output into a 记忆手帐 memo card (tagged 小钻风)
async function toMemo(content, btn) {
  if (!content) return;
  try {
    await fetch("/api/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, tags: ["小钻风"] }) });
    if (btn) { btn.textContent = "✓ 已存手帐"; btn.disabled = true; }
    toast("已存进手帐 · 标签 #小钻风");
  } catch (_) { toast("存手帐失败"); }
}
function toast(msg) {
  let t = $("#xzf-toast");
  if (!t) { t = document.createElement("div"); t.id = "xzf-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

// upload today's deck HTML → save to deck folder → load it
async function uploadDeck(e) {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  setStatus("上传中…");
  try {
    const fd = new FormData(); fd.append("deck", f);
    const res = await fetch("/api/reader/upload", { method: "POST", body: fd }).then((r) => r.json());
    if (res.error) { setStatus("上传失败"); alert("上传失败：" + res.error); return; }
    const { decks } = await api.get("/api/reader/decks");
    state.decks = decks;
    setStatus("已上传 " + res.date);
    toast("已上传导读 · " + res.date);
    loadDeck(res.date);
  } catch (err) { setStatus("上传失败"); alert("上传失败：" + err.message); }
}

// translation model status → if local model unavailable, offer a one-click pull
async function checkTx() {
  let s; try { s = await api.get("/api/reader/translate/status"); } catch { return; }
  if (s.up && s.hasFast) return;  // local fast model ready — nothing to nudge
  const box = document.createElement("div");
  box.id = "tx-banner";
  if (!s.up) {
    box.innerHTML = `本地翻译未启用，正用 <b>CC 翻译</b>（较慢、走额度）。装并运行 <b>Ollama</b> 后可一键下载更快的本地模型。<a href="https://ollama.com" target="_blank">怎么装 →</a>`;
  } else {
    box.innerHTML = `Ollama 已就绪，但还没下载快速翻译模型 <b>${s.fast}</b>。<button id="tx-pull">下载（约 2GB，一次即可）</button> <span id="tx-prog"></span>`;
  }
  $("#panel").insertBefore(box, $("#panel").firstChild);
  const pull = $("#tx-pull");
  if (pull) pull.onclick = () => pullModel(s.fast);
}
async function pullModel(model) {
  const prog = $("#tx-prog"); const btn = $("#tx-pull");
  btn.disabled = true; prog.textContent = "下载中…";
  try {
    const r = await fetch("/api/reader/translate/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const ln of lines) { if (!ln.trim()) continue; try { const o = JSON.parse(ln); if (o.status) prog.textContent = o.status; if (o.error) prog.textContent = "失败：" + o.error; } catch (_) {} }
    }
    prog.textContent = "✓ 完成"; $("#tx-banner")?.remove(); toast("本地翻译模型已就绪");
  } catch (e) { prog.textContent = "失败：" + e.message; btn.disabled = false; }
}

async function refreshGraph() {
  state.graph = await api.get("/api/reader/graph");
  state.postBySlide = {};
  state.graph.posts.filter((p) => p.date === state.date).forEach((p) => (state.postBySlide[p.slide_index] = p.id));
}

// ------------------------------------------------------------- date picker
function bindDatepicker() {
  $("#dp-btn").onclick = (e) => { e.stopPropagation(); toggleCal(); };
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#datepicker")) $("#dp-pop").hidden = true; });
}
function toggleCal() {
  const pop = $("#dp-pop");
  if (!pop.hidden) { pop.hidden = true; return; }
  const [y, m] = (state.date || todayStr()).split("-").map(Number);
  state.dpMonth = { y, m: m - 1 };
  drawCal();
  pop.hidden = false;
}
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function drawCal() {
  const { y, m } = state.dpMonth;
  const deckDates = new Set(state.decks.map((d) => d.date));
  const startDow = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayStr();
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<div class="dp-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cls = ["dp-cell", deckDates.has(ds) ? "has" : "", ds === state.date ? "sel" : "", ds === today ? "today" : ""].filter(Boolean).join(" ");
    cells += `<div class="${cls}" data-date="${ds}">${d}${deckDates.has(ds) ? '<span class="dot"></span>' : ""}</div>`;
  }
  $("#dp-pop").innerHTML = `
    <div class="dp-head"><button class="dp-nav" data-nav="-1">‹</button><span>${y}-${String(m + 1).padStart(2, "0")}</span><button class="dp-nav" data-nav="1">›</button></div>
    <div class="dp-week">${["日", "一", "二", "三", "四", "五", "六"].map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="dp-grid">${cells}</div>`;
  $("#dp-pop").querySelectorAll(".dp-nav").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    let mm = state.dpMonth.m + +b.dataset.nav, yy = state.dpMonth.y;
    if (mm < 0) { mm = 11; yy--; } if (mm > 11) { mm = 0; yy++; }
    state.dpMonth = { y: yy, m: mm }; drawCal();
  }));
  $("#dp-pop").querySelectorAll(".dp-cell.has").forEach((c) => (c.onclick = (e) => { e.stopPropagation(); loadDeck(c.dataset.date); }));
}

// -------------------------------------------------------------- deck loading
async function loadDeck(date) {
  state.date = date;
  $("#dp-btn").textContent = "📅 " + date;
  $("#dp-pop").hidden = true;
  setStatus("载入…");
  await refreshGraph();
  const raw = await fetch("/api/reader/deck_raw?date=" + encodeURIComponent(date)).then((r) => r.text());
  const html = injectReflow(raw);
  const iframe = $("#deck");
  iframe.onload = () => onDeckReady(iframe);
  iframe.srcdoc = html;
}

function injectReflow(raw) {
  let html = raw.replace(/<script[\s\S]*?<\/script>/gi, ""); // drop deck nav/scaling JS
  const css = `<style id="xzf-reflow">${REFLOW_CSS}</style>`;
  return html.includes("</head>") ? html.replace("</head>", css + "</head>") : css + html;
}

function onDeckReady(iframe) {
  const idoc = iframe.contentDocument;
  idoc.querySelectorAll(".slide").forEach((s, i) => (s.dataset.slideIndex = i));
  idoc.addEventListener("mouseup", onSelect);
  idoc.addEventListener("scroll", hideToolbar, true);
  idoc.addEventListener("click", (e) => {
    const m = e.target.closest(".xzf-anno");
    if (m) focusAnno(m.dataset.annoId);
  });
  fitDeck();
  restoreAnnotations();
  renderAnnoList();
  setStatus(state.postBySlide && Object.keys(state.postBySlide).length ? "" : "未入图谱");
}

// deck auto-fits to the reading column width — wider left column ⇒ bigger deck
function fitDeck() {
  const iframe = $("#deck");
  const idoc = iframe.contentDocument;
  if (!idoc || !idoc.body) return;
  const z = Math.max(0.2, +(iframe.clientWidth / 1920).toFixed(3));
  idoc.body.style.zoom = z;
  requestAnimationFrame(() => { iframe.style.height = idoc.body.scrollHeight + "px"; });
}

// draggable splitter: drag left ⇒ right panel grows / reading shrinks; drag right ⇒ reading (and deck) grow
function bindDivider() {
  const div = $("#divider"), side = $("#side");
  const saved = localStorage.getItem("xzf-side-w");
  if (saved) side.style.flexBasis = saved + "px";
  let dragging = false;
  div.addEventListener("mousedown", (e) => {
    dragging = true; div.classList.add("dragging"); document.body.style.cursor = "col-resize";
    $("#deck").style.pointerEvents = "none";  // let mousemove pass over the iframe while dragging
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    let w = Math.max(240, Math.min(window.innerWidth - 320, window.innerWidth - e.clientX));
    side.style.flexBasis = w + "px";
    fitDeck();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; div.classList.remove("dragging"); document.body.style.cursor = "";
    $("#deck").style.pointerEvents = "";
    localStorage.setItem("xzf-side-w", parseInt(side.style.flexBasis));
    fitDeck();
  });
}

// --------------------------------------------------------------- selection
function slideOf(node) {
  let el = node.nodeType === 3 ? node.parentNode : node;
  while (el && !(el.dataset && el.dataset.slideIndex !== undefined)) el = el.parentNode;
  return el;
}

function onSelect() {
  const idoc = $("#deck").contentDocument;
  const s = idoc.getSelection();
  if (!s.rangeCount || s.isCollapsed) return hideToolbar();
  const text = s.toString().trim();
  if (text.length < 1) return hideToolbar();
  const range = s.getRangeAt(0);
  const slideEl = slideOf(range.startContainer);
  const slideIndex = slideEl ? +slideEl.dataset.slideIndex : -1;
  const full = slideEl ? slideEl.textContent : text;
  const qi = full.indexOf(text);
  state.sel = {
    text, slideIndex,
    prefix: qi > 0 ? full.slice(Math.max(0, qi - 24), qi) : "",
    suffix: qi >= 0 ? full.slice(qi + text.length, qi + text.length + 24) : "",
  };
  showToolbar(range);
  autoTranslate(state.sel);   // 选中即译
}

// ----------------------------------------------------------- live translation
let txToken = 0;
async function autoTranslate(sel) {
  if (!$("#auto-tx").checked) return;   // 自动翻译开关关闭时跳过
  const lt = $("#live-tx");
  $("#panel-empty").style.display = "none";
  lt.hidden = false;
  switchTab("panel");
  lt.querySelector(".lt-src").textContent = sel.text;
  const out = lt.querySelector(".lt-out"), eng = lt.querySelector(".lt-eng");
  const ENG = { fast: "本地·快", fine: "本地·精", cc: "CC·精翻" };
  const token = ++txToken;
  const render = async (mode) => {
    out.innerHTML = `<span class="spin"></span>`;
    eng.textContent = "";
    const res = await api.post("/api/reader/translate", { text: sel.text, mode });
    if (token !== txToken) return;  // a newer selection has superseded this one
    out.textContent = res.translation || ("翻译失败：" + (res.error || "?"));
    eng.textContent = ENG[res.engine] || res.engine;
    lt._tx = res.translation;
  };
  await render("fast");                                   // instant local 3b
  lt.querySelector(".lt-cc").onclick = () => render("fine"); // 精翻 = local 7b
  lt.querySelector(".lt-save").onclick = async () => {
    const a = newAnno("translate", sel); a.payload = lt._tx || "";
    highlight(a); await saveAnno(a);
    lt.querySelector(".lt-save").textContent = "✓ 已存";
  };
  const memoBtn = lt.querySelector(".lt-memo"); memoBtn.disabled = false; memoBtn.textContent = "存进手帐";
  memoBtn.onclick = () => toMemo(`【小钻风译文】${sel.text}\n— ${lt._tx || ""}`, memoBtn);
}

function showToolbar(range) {
  const tb = $("#sel-toolbar");
  const ir = $("#deck").getBoundingClientRect();
  const rr = range.getBoundingClientRect();
  tb.hidden = false;
  let top = ir.top + rr.top - tb.offsetHeight - 8;
  if (top < 60) top = ir.top + rr.bottom + 8;
  tb.style.top = Math.max(60, top) + "px";
  tb.style.left = Math.min(window.innerWidth - tb.offsetWidth - 10, Math.max(8, ir.left + rr.left)) + "px";
}
const hideToolbar = () => ($("#sel-toolbar").hidden = true);

function bindToolbar() {
  $("#sel-toolbar").addEventListener("mousedown", (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    e.preventDefault();
    handleAction(act);
    hideToolbar();
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#sel-toolbar") && !$("#deck").contains(e.target)) hideToolbar();
  });
}

// ----------------------------------------------------------------- actions
function newAnno(kind, sel = state.sel) {
  return {
    id: "a_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    created_at: new Date().toISOString(), date: state.date,
    post_id: state.postBySlide[sel.slideIndex] || null,
    slide_index: sel.slideIndex,
    anchor: { quote: sel.text, prefix: sel.prefix, suffix: sel.suffix, slide_index: sel.slideIndex },
    kind, payload: "", answer: "", linked_entities: [],
  };
}

function handleAction(act) {
  switchTab("panel");
  $("#panel-empty").style.display = "none";
  if (act === "note") cardNote();
  else if (act === "tag") cardTag();
  else if (act === "term") cardTerm();
  else if (act === "ask") cardAsk();
}

function makeCard(kind, headLabel) {
  const c = document.createElement("div");
  c.className = "card kind-" + kind;
  c.innerHTML = `<div class="card-head"><span>${headLabel}</span><span class="t">${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div>
    <div class="quote">${escapeHtml(state.sel.text)}</div><div class="cbody"></div>`;
  $("#panel-cards").prepend(c);
  return c.querySelector(".cbody");
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

function cardNote() {
  const anno = newAnno("note");
  highlight(anno);
  const b = makeCard("note", "✎ 笔记");
  b.innerHTML = `<textarea rows="3" placeholder="写下你的想法…"></textarea>
    <div class="row"><button class="primary">保存</button><button class="danger">删除</button></div>`;
  const ta = b.querySelector("textarea"); ta.focus();
  b.querySelector(".primary").onclick = async () => { anno.payload = ta.value; await saveAnno(anno); flashSaved(b); };
  b.querySelector(".danger").onclick = () => removeAnno(anno, b.closest(".card"));
}

function cardTag() {
  const anno = newAnno("tag");
  highlight(anno);
  const b = makeCard("tag", "🏷 标签");
  b.innerHTML = `<input type="text" placeholder="如 #值得深挖 #反对 #想试">
    <div class="row"><button class="primary">保存</button><button class="danger">删除</button></div>`;
  const inp = b.querySelector("input"); inp.focus();
  b.querySelector(".primary").onclick = async () => { anno.payload = inp.value; await saveAnno(anno); flashSaved(b); };
  b.querySelector(".danger").onclick = () => removeAnno(anno, b.closest(".card"));
}

async function cardTerm() {
  const anno = newAnno("term");
  highlight(anno);
  const b = makeCard("term", "📖 术语");
  b.innerHTML = `<div class="out zh"><span class="spin"></span> CC 正在解释「${escapeHtml(state.sel.text)}」…</div>`;
  const out = b.querySelector(".out");
  const ctx = slideText(anno.slide_index);
  const res = await api.post("/api/reader/define", { term: state.sel.text, context: ctx, date: state.date, post_id: anno.post_id });
  if (res.error) { out.textContent = "失败：" + res.error; return; }
  out.textContent = res.definition;
  if (res.entity) b.insertAdjacentHTML("beforeend", `<div class="ent">已写入图谱实体 · <b>${escapeHtml(res.entity.canonical_name)}</b> (${res.entity.type})</div>`);
  anno.payload = state.sel.text; anno.answer = res.definition;
  if (res.entity) anno.linked_entities = [res.entity.id];
  await saveAnno(anno);
  await refreshGraph();
  b.insertAdjacentHTML("beforeend", `<div class="row"><button class="memo">存进手帐</button></div>`);
  b.querySelector(".memo").onclick = (e) => toMemo(`【小钻风术语】${state.sel.text}\n${res.definition}`, e.target);
}

async function cardAsk() {
  const anno = newAnno("ask");
  const b = makeCard("ask", "？问 CC");
  b.innerHTML = `<input type="text" placeholder="就这段问点什么…（回车发送）">
    <div class="out" style="margin-top:8px"></div>`;
  const inp = b.querySelector("input"); const out = b.querySelector(".out"); inp.focus();
  inp.onkeydown = async (e) => {
    if (e.key !== "Enter" || !inp.value.trim()) return;
    const q = inp.value.trim(); inp.disabled = true;
    out.innerHTML = `<span class="spin"></span> CC 思考中…`;
    const res = await api.post("/api/reader/ask", { question: q, context: state.sel.text, date: state.date });
    out.classList.add("zh"); out.textContent = res.answer || ("失败：" + (res.error || "?"));
    anno.payload = q; anno.answer = res.answer || "";
    inp.disabled = false;
    b.insertAdjacentHTML("beforeend", `<div class="row"><button class="primary">保存这次问答</button><button class="memo">存进手帐</button></div>`);
    b.querySelector(".primary").onclick = async () => { highlight(anno); await saveAnno(anno); flashSaved(b); };
    b.querySelector(".memo").onclick = (e) => toMemo(`【小钻风问答】${q}\n${anno.answer}`, e.target);
  };
}

function slideText(i) {
  const idoc = $("#deck").contentDocument;
  const s = idoc.querySelector(`.slide[data-slide-index="${i}"]`);
  return s ? s.textContent.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
}

// ----------------------------------------------------------- highlight anchor
function highlight(anno) {
  const idoc = $("#deck").contentDocument;
  const slideEl = idoc.querySelector(`.slide[data-slide-index="${anno.anchor.slide_index}"]`);
  if (!slideEl) return;
  const range = locateQuote(idoc, slideEl, anno.anchor.quote, anno.anchor.prefix);
  if (range) wrapRange(idoc, range, anno);
}

function locateQuote(idoc, root, quote, prefix) {
  const walker = idoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let full = "";
  while (walker.nextNode()) { const n = walker.currentNode; nodes.push([n, full.length]); full += n.nodeValue; }
  let idx = -1, from = 0;
  while (true) {
    const p = full.indexOf(quote, from); if (p < 0) break;
    if (idx < 0) idx = p;
    if (prefix && full.slice(Math.max(0, p - prefix.length), p).endsWith(prefix.slice(-10))) { idx = p; break; }
    from = p + 1;
  }
  if (idx < 0) return null;
  const at = (pos) => { for (const [n, off] of nodes) if (pos <= off + n.nodeValue.length) return [n, pos - off]; const l = nodes[nodes.length - 1]; return [l[0], l[0].nodeValue.length]; };
  const [sn, so] = at(idx), [en, eo] = at(idx + quote.length);
  const r = idoc.createRange(); r.setStart(sn, so); r.setEnd(en, eo); return r;
}

function wrapRange(idoc, range, anno) {
  const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  const walker = idoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const inRange = [];
  while (walker.nextNode()) { if (range.intersectsNode(walker.currentNode)) inRange.push(walker.currentNode); }
  inRange.forEach((n) => {
    let s = 0, e = n.nodeValue.length;
    if (n === range.startContainer) s = range.startOffset;
    if (n === range.endContainer) e = range.endOffset;
    if (s >= e) return;
    const r = idoc.createRange(); r.setStart(n, s); r.setEnd(n, e);
    const mark = idoc.createElement("mark"); mark.className = "xzf-anno xzf-" + anno.kind; mark.dataset.annoId = anno.id;
    try { r.surroundContents(mark); } catch (_) {}
  });
}

function restoreAnnotations() {
  (state.graph.annotations || []).filter((a) => a.date === state.date).forEach((a) => { if (a.anchor) highlight(a); });
}

// ----------------------------------------------------------------- persistence
async function saveAnno(anno) {
  setStatus("保存中…");
  await api.post("/api/reader/annotate", { annotation: anno });
  await refreshGraph();
  renderAnnoList();
  setStatus("已保存");
  setTimeout(() => setStatus(""), 1200);
}
async function removeAnno(anno, cardEl) {
  await api.post("/api/reader/annotate", { delete: anno.id });
  const idoc = $("#deck").contentDocument;
  idoc.querySelectorAll(`.xzf-anno[data-anno-id="${anno.id}"]`).forEach((m) => { m.replaceWith(...m.childNodes); });
  if (cardEl) cardEl.remove();
  await refreshGraph(); renderAnnoList();
}
const flashSaved = (b) => { const s = document.createElement("span"); s.textContent = " ✓ 已存"; s.style.color = "#5FA463"; s.style.fontSize = "12px"; b.querySelector(".row")?.appendChild(s); };

// ----------------------------------------------------------------- anno list
function renderAnnoList() {
  const list = (state.graph.annotations || []).filter((a) => a.date === state.date)
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  $("#anno-count").textContent = list.length;
  const KIND = { note: "笔记", tag: "标签", term: "术语", ask: "问CC", translate: "翻译" };
  $("#anno-list").innerHTML = list.length ? list.map((a) => `
    <div class="anno-item" data-id="${a.id}">
      <button class="del" title="删除这条标注" data-del="${a.id}">✕</button>
      <span class="k kind-${a.kind}">${KIND[a.kind] || a.kind}</span>
      <p class="q">“${escapeHtml((a.anchor?.quote || "").slice(0, 90))}”</p>
      ${a.payload ? `<p class="p">${escapeHtml(a.payload)}</p>` : ""}
      ${a.answer ? `<p class="p" style="color:#444">${escapeHtml(a.answer.slice(0, 160))}${a.answer.length > 160 ? "…" : ""}</p>` : ""}
    </div>`).join("") : `<p class="hint">这天还没有标注。</p>`;
  $("#anno-list").querySelectorAll(".anno-item").forEach((el) => (el.onclick = () => scrollToAnno(el.dataset.id)));
  $("#anno-list").querySelectorAll(".del").forEach((btn) => (btn.onclick = async (e) => {
    e.stopPropagation();
    const a = (state.graph.annotations || []).find((x) => x.id === btn.dataset.del);
    if (a && confirm("删除这条标注？")) await removeAnno(a);
  }));
}

function scrollToAnno(id) {
  const idoc = $("#deck").contentDocument;
  const m = idoc.querySelector(`.xzf-anno[data-anno-id="${id}"]`);
  if (!m) return;
  m.scrollIntoView({ behavior: "smooth", block: "center" });
  m.classList.add("xzf-flash"); setTimeout(() => m.classList.remove("xzf-flash"), 1200);
}
function focusAnno(id) {
  switchTab("annos");
  const el = $(`#anno-list .anno-item[data-id="${id}"]`);
  if (el) { el.style.borderColor = "var(--vermilion)"; el.scrollIntoView({ block: "center" }); setTimeout(() => (el.style.borderColor = ""), 1200); }
}

// ----------------------------------------------------------------- misc
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === name));
}

async function extractCurrent() {
  if (!confirm(`用 CC 抽取 ${state.date} 这篇导读到知识图谱？（会调用 claude，稍等十几秒）`)) return;
  setStatus("抽取中…"); $("#btn-extract").disabled = true;
  const res = await api.post("/api/reader/extract", { date: state.date });
  $("#btn-extract").disabled = false;
  if (res.error) { setStatus("失败"); alert("抽取失败：" + res.error); return; }
  if (res.status === "already_extracted") { setStatus("已在图谱"); alert("这篇已经在图谱里了。"); return; }
  await refreshGraph();
  setStatus("已入图谱"); alert(`已并入图谱：新增 posts ${res.added?.posts||0} / 实体 ${res.added?.entities||0} / 观点 ${res.added?.opinions||0} / 关系 ${res.added?.relations||0}`);
}

boot();
