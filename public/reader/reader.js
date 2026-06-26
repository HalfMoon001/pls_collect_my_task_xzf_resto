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
  .xzf-task{background:#FFC24D;box-shadow:inset 0 -2px 0 #E08A2B;font-weight:600;}
  .xzf-anno:hover,.xzf-flash{outline:2px solid var(--vermilion,#B5252B);}
`;

const $ = (s) => document.querySelector(s);
const state = { date: null, graph: null, postBySlide: {}, sel: null, decks: [], dpMonth: null };

// fetch wrappers that never throw — network/parse failures come back as { error }
// so every caller can branch on res.error instead of crashing mid-action.
const api = {
  get: async (u) => {
    try { const r = await fetch(u); return await r.json(); }
    catch (e) { return { error: "网络错误：" + (e.message || e) }; }
  },
  post: async (u, b) => {
    try {
      const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      return await r.json();
    } catch (e) { return { error: "网络错误：" + (e.message || e) }; }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST to a CC-backed endpoint. The server queues CC jobs, so a request normally
// just waits its turn; only a *full* queue answers 409 ({busy:true}). In that case
// back off and retry a few times, calling onWait so the UI can say「排队中」.
async function ccPost(u, b, onWait) {
  for (let i = 0; i < 6; i++) {
    const res = await api.post(u, b);
    if (res && res.busy) { if (onWait) onWait(i); await sleep(900 + i * 700); continue; }
    return res;
  }
  return { error: "CC 一直很忙，稍后再试。", busy: true };
}
const setStatus = (t) => { $("#status").textContent = t || ""; };

// ----------------------------------------------------------------- bootstrap
async function boot() {
  const { decks } = await api.get("/api/reader/decks");
  state.decks = decks;
  bindDatepicker();
  bindDropzone();
  $("#btn-upload").onclick = () => $("#file-deck").click();
  $("#file-deck").onchange = uploadDeck;
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  bindToolbar();
  bindDivider();
  const at = $("#auto-tx");
  at.checked = localStorage.getItem("xzf-autotx") !== "0";
  at.onchange = () => localStorage.setItem("xzf-autotx", at.checked ? "1" : "0");
  window.addEventListener("resize", fitDeck);
  document.addEventListener("keydown", onEsc);
  checkTx();
  if (decks.length) loadDeck(decks[0].date);
  else $("#reading").innerHTML = "<p style='margin:auto;color:#888'>还没有导读。把每天的 HTML 丢进 data/reader/decks/ 即可。</p>";
}

// ----------------------------------------------- coupling: 存进手帐 + 翻译模型
// turn any reader output into a 记忆手帐 memo card (tagged 小钻风)
async function toMemo(content, btn, tags = ["小钻风"]) {
  if (!content) return;
  try {
    await fetch("/api/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, tags }) });
    if (btn) { btn.textContent = "✓ 已存手帐"; btn.disabled = true; }
    toast("已存进手帐 · 标签 #小钻风");
  } catch (_) { toast("存手帐失败"); }
}

// Build the 手帐 memo text for any annotation kind — so every item in the 标注
// list (note/tag/term/ask/translate) can be sent to 记忆手帐.
function memoText(a) {
  const q = (a.anchor && a.anchor.quote) || "";
  const p = a.payload || "", ans = a.answer || "";
  switch (a.kind) {
    case "note": return `【小钻风笔记】“${q}”\n${p}`;
    case "tag": return `【小钻风标签】${p}\n— 原文：“${q}”`;
    case "term": return `【小钻风术语】${p || q}\n${ans}`;
    case "ask": return `【小钻风问答】${p}\n${ans}`;
    case "translate": return `【小钻风译文】${q}\n— ${p}`;
    case "task": return `【小钻风任务】${p}\n— 原文：“${q}”`;
    default: return `【小钻风】“${q}”\n${p || ans}`;
  }
}
function toast(msg) {
  let t = $("#xzf-toast");
  if (!t) { t = document.createElement("div"); t.id = "xzf-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

// Prominent ingest progress pill. state: "busy" (spinner, stays) | "done" | "error" (auto-hide).
// Upload is instant but extract+detect are ~20s of background CC — this makes that visible.
function ingest(state, text) {
  let el = $("#ingest");
  if (!el) { el = document.createElement("div"); el.id = "ingest"; document.body.appendChild(el); }
  clearTimeout(ingest._t);
  el.className = "show " + state;
  el.innerHTML = (state === "busy" ? `<span class="spin"></span> ` : state === "done" ? "✅ " : "⚠️ ") + text;
  if (state !== "busy") ingest._t = setTimeout(() => el.classList.remove("show"), 7000);
}

// upload today's deck HTML → save → load → 自动抽取收录 → 找任务，全程一个进度条
function uploadDeck(e) { const f = e.target.files[0]; e.target.value = ""; uploadFile(f); }

async function uploadFile(f) {
  if (!f) return;
  if (!/\.html?$/i.test(f.name || "")) { toast("请拖入 .html 导读文件"); return; }
  ingest("busy", "上传中…");
  try {
    const fd = new FormData(); fd.append("deck", f);
    const res = await fetch("/api/reader/upload", { method: "POST", body: fd }).then((r) => r.json());
    if (res.error) { ingest("error", "上传失败：" + res.error); return; }
    const { decks } = await api.get("/api/reader/decks");
    state.decks = decks;
    loadDeck(res.date);
    if (res.dateGuessed) toast(`没在导读里找到日期，暂按今天 ${res.date}（建议文件名或标题带 YYYY-MM-DD）`);

    ingest("busy", `①/② 解析收录这篇…（CC，约十几秒）`);
    const ex = await autoExtract(res.date);
    if (ex && ex.error) { ingest("error", "抽取失败：" + ex.error + "（重新上传可重试）"); return; }

    ingest("busy", `②/② 找评论里的任务…（CC）`);
    const tk = await autoDetectTasks(res.date);

    const exMsg = ex && ex.status === "already_extracted"
      ? "已收录过"
      : `收录 ${ex?.added?.entities || 0} 实体 / ${ex?.added?.opinions || 0} 观点`;
    const tkMsg = tk && tk.error ? "，任务检测失败" : `，${(tk && tk.added) || 0} 个任务 📌`;
    ingest("done", `${res.date} 已完成 · ${exMsg}${tkMsg}`);
  } catch (err) { ingest("error", "上传失败：" + err.message); }
}

// extract a deck into the store; returns the server result. Idempotent.
async function autoExtract(date) {
  const res = await ccPost("/api/reader/extract", { date }, () => ingest("busy", "CC 排队中，待解析收录…"));
  if (res && !res.error && res.status !== "already_extracted") await refreshGraph();
  return res;
}

// scan the day's commentary for action-tasks (CC) and highlight them; returns the result.
async function autoDetectTasks(date) {
  const res = await ccPost("/api/reader/detect_tasks", { date }, () => ingest("busy", "CC 排队中，待找任务…"));
  if (res && !res.error) {
    await refreshGraph();
    if (state.date === date) {
      (res.newTasks || []).forEach((a) => highlight(a));   // highlight just the new ones (avoid re-wrapping)
      renderAnnoList();
    }
  }
  return res;
}

// drag a .html anywhere onto the page to upload it (same flow as the button).
// The deck lives in an iframe, so during a drag we cover it with a full-page
// overlay (and disable its pointer events) — otherwise dropping on the iframe
// would make the browser navigate to the file.
function bindDropzone() {
  const overlay = $("#drop-overlay");
  const deck = $("#deck");
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  let depth = 0;
  const show = () => { overlay.classList.add("show"); if (deck) deck.style.pointerEvents = "none"; };
  const hide = () => { depth = 0; overlay.classList.remove("show"); if (deck) deck.style.pointerEvents = ""; };
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(); });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth--; if (depth <= 0) hide(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); hide();
    uploadFile(e.dataTransfer.files[0]);
  });
}

// Ingest a deck into the store (companies / opinions / posts / relations) via CC,
// so 演变追踪 and 学习 pick it up. Runs in the background after upload — the user
// can read while CC works. Idempotent (server guards against re-extracting a date).
async function autoExtract(date) {
  setStatus("正在抽取收录…（CC，约十几秒）");
  const res = await ccPost("/api/reader/extract", { date }, () => setStatus("CC 排队中，待抽取收录…"));
  if (!res || res.error) { setStatus(""); toast("抽取失败：" + ((res && res.error) || "无响应") + "（重新上传可重试）"); return; }
  if (res.status === "already_extracted") { setStatus(""); toast("这篇已收录过"); return; }
  await refreshGraph();
  setStatus("");
  toast(`已收录 · 新增 ${res.added?.entities || 0} 实体 / ${res.added?.opinions || 0} 观点，已进演变追踪`);
}

// translation model status → if local model unavailable, offer a one-click pull
// The server auto-starts `ollama serve` and auto-pulls the fast model when Ollama
// is installed. This just mirrors that progress in a banner and polls until ready,
// so the user normally does nothing. Manual download stays as a fallback.
let txPoll = null;
function renderTxBanner(s) {
  if (s.up && s.hasFast) {                       // ready → clear banner, stop polling
    $("#tx-banner")?.remove();
    if (txPoll) { clearInterval(txPoll); txPoll = null; }
    return true;
  }
  let box = $("#tx-banner");
  if (!box) { box = document.createElement("div"); box.id = "tx-banner"; $("#panel").insertBefore(box, $("#panel").firstChild); }
  const p = s.pull || {};
  if (!s.up) {
    box.innerHTML = `本地翻译未启用（没检测到 Ollama）。<b>装好 Ollama 就会自动开启、自动下载模型</b>，现在先用 <b>CC 翻译</b> 兜底。<a href="https://ollama.com" target="_blank">怎么装 →</a>`;
  } else if (p.pulling) {
    box.innerHTML = `正在自动下载本地翻译模型 <b>${s.fast}</b>…（约 2GB，仅一次）<span id="tx-prog">${p.percent || 0}% ${escapeHtml(p.status || "")}</span>`;
  } else if (p.error) {
    box.innerHTML = `本地模型下载失败：${escapeHtml(p.error)}　<button id="tx-pull">重试</button> <span id="tx-prog"></span>`;
    $("#tx-pull").onclick = () => pullModel(s.fast);
  } else {
    box.innerHTML = `Ollama 已就绪，正在准备下载快速翻译模型 <b>${s.fast}</b>…　<button id="tx-pull">手动下载</button> <span id="tx-prog"></span>`;
    $("#tx-pull").onclick = () => pullModel(s.fast);
  }
  return false;
}
async function checkTx() {
  let s; try { s = await api.get("/api/reader/translate/status"); } catch { return; }
  if (renderTxBanner(s)) return;
  if (txPoll) return;
  txPoll = setInterval(async () => {
    let st; try { st = await api.get("/api/reader/translate/status"); } catch { return; }
    if (renderTxBanner(st)) toast("本地翻译已就绪");  // poll only runs while not-ready → true = just became ready
  }, 1500);
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
  const annoDates = new Set((state.graph?.annotations || []).map((a) => a.date));  // days I've annotated → 橙点
  const startDow = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayStr();
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<div class="dp-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cls = ["dp-cell", deckDates.has(ds) ? "has" : "", ds === state.date ? "sel" : "", ds === today ? "today" : ""].filter(Boolean).join(" ");
    let dots = "";
    if (deckDates.has(ds)) dots += '<span class="dot dot-deck" title="有导读"></span>';
    if (annoDates.has(ds)) dots += '<span class="dot dot-anno" title="有标注"></span>';
    cells += `<div class="${cls}" data-date="${ds}">${d}${dots ? `<span class="dots">${dots}</span>` : ""}</div>`;
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
  idoc.addEventListener("keydown", onEsc);
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
    prefix: qi > 0 ? full.slice(Math.max(0, qi - 40), qi) : "",
    suffix: qi >= 0 ? full.slice(qi + text.length, qi + text.length + 40) : "",
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
    out.textContent = (res && res.translation) || ("翻译失败：" + ((res && res.error) || "?"));
    // 若请求的是本地模型却落到了 CC，说明本地不可用——明示，别让用户以为「怎么变慢了」
    eng.textContent = (ENG[res.engine] || res.engine || "") + (res.engine === "cc" && mode !== "cc" ? "（本地不可用）" : "");
    lt._tx = res && res.translation;
  };
  await render("fast");                                   // instant local 3b
  lt.querySelector(".lt-cc").onclick = () => render("fine"); // 精翻 = local 7b
  lt.querySelector(".lt-save").onclick = async () => {
    if (!lt._tx) { toast("还没有译文可存"); return; }
    const a = newAnno("translate", sel); a.payload = lt._tx;
    highlight(a);
    if (await saveAnno(a)) lt.querySelector(".lt-save").textContent = "✓ 已存";
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
// ESC dismisses the floating toolbar and clears the selection (works whether
// focus is in the deck iframe or the top document — both fire this).
function onEsc(e) {
  if (e.key !== "Escape") return;
  hideToolbar();
  const idoc = $("#deck").contentDocument;
  try { idoc && idoc.getSelection().removeAllRanges(); } catch (_) {}
}

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
  mountEditable(anno, b, b.closest(".card"), true);   // start in edit; collapses to saved view after 保存
}

function cardTag() {
  const anno = newAnno("tag");
  highlight(anno);
  const b = makeCard("tag", "🏷 标签");
  mountEditable(anno, b, b.closest(".card"), true);
}

// Editable note/tag annotation, shared by the transient panel card AND the
// persistent 标注 list item. Two states:
//   saved → read-only value + [编辑][删除]
//   edit  → field + [保存]([取消])[删除]   (取消 only when editing an existing one)
// After 保存 it collapses back to the saved view — so the card no longer looks
// "still editable", and list items stay editable across refreshes/reloads.
function mountEditable(anno, body, cardEl, startInEdit) {
  const isTag = anno.kind === "tag";
  const del = (ask) => { if (ask && !confirm("删除这条标注？")) return; removeAnno(anno, cardEl); };
  function saved() {
    body.innerHTML = `<div class="saved-val">${anno.payload ? escapeHtml(anno.payload) : '<i class="muted">（空，点编辑补充）</i>'}</div>
      <div class="row"><button class="edit">编辑</button><button class="memo">存手帐</button><button class="danger">删除</button></div>`;
    body.querySelector(".edit").onclick = () => edit(true);
    body.querySelector(".memo").onclick = (e) => toMemo(memoText(anno), e.target);
    body.querySelector(".danger").onclick = () => del(true);
  }
  function edit(cancelable) {
    body.innerHTML = (isTag
      ? `<input type="text" placeholder="如 #值得深挖 #反对 #想试">`
      : `<textarea rows="3" placeholder="写下你的想法…"></textarea>`)
      + `<div class="row"><button class="primary">保存</button>${cancelable ? '<button class="cancel">取消</button>' : ""}<button class="danger">删除</button></div>`;
    const field = body.querySelector(isTag ? "input" : "textarea");
    field.value = anno.payload || ""; field.focus();
    body.querySelector(".primary").onclick = async () => { anno.payload = field.value; if (await saveAnno(anno)) saved(); };
    const c = body.querySelector(".cancel"); if (c) c.onclick = saved;
    body.querySelector(".danger").onclick = () => del(cancelable);  // confirm only when editing an existing one
  }
  startInEdit ? edit(false) : saved();
}

async function cardTerm() {
  const anno = newAnno("term");
  highlight(anno);
  const b = makeCard("term", "📖 术语");
  b.innerHTML = `<div class="out zh"><span class="spin"></span> CC 正在解释「${escapeHtml(state.sel.text)}」…</div>`;
  const out = b.querySelector(".out");
  const ctx = slideText(anno.slide_index);
  const res = await ccPost("/api/reader/define", { term: state.sel.text, context: ctx, date: state.date, post_id: anno.post_id },
    () => { out.innerHTML = `<span class="spin"></span> CC 排队中，马上轮到「${escapeHtml(state.sel.text)}」…`; });
  if (!res || res.error) { out.textContent = "失败：" + ((res && res.error) || "无响应"); return; }
  if (!res.definition) { out.textContent = "没拿到解释，再试一次吧。"; return; }
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
    const res = await ccPost("/api/reader/ask", { question: q, context: state.sel.text, date: state.date },
      () => { out.innerHTML = `<span class="spin"></span> CC 排队中，马上轮到这个问题…`; });
    out.classList.add("zh"); out.textContent = (res && res.answer) || ("失败：" + ((res && res.error) || "无响应"));
    anno.payload = q; anno.answer = (res && res.answer) || "";
    inp.disabled = false;
    b.insertAdjacentHTML("beforeend", `<div class="row"><button class="primary">保存这次问答</button><button class="memo">存进手帐</button></div>`);
    b.querySelector(".primary").onclick = async () => { highlight(anno); if (await saveAnno(anno)) flashSaved(b); };
    b.querySelector(".memo").onclick = (e) => toMemo(`【小钻风问答】${q}\n${anno.answer}`, e.target);
  };
}

function slideText(i) {
  const idoc = $("#deck").contentDocument;
  const s = idoc.querySelector(`.slide[data-slide-index="${i}"]`);
  return s ? s.textContent.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
}

// ----------------------------------------------------------- highlight anchor
// Returns true if the quote was located & marked, false otherwise (so callers
// like restoreAnnotations can count anchors that drifted off the current deck).
function highlight(anno) {
  const idoc = $("#deck").contentDocument;
  const slideEl = idoc.querySelector(`.slide[data-slide-index="${anno.anchor.slide_index}"]`);
  if (!slideEl) return false;
  const range = locateQuote(idoc, slideEl, anno.anchor);
  if (!range) return false;
  wrapRange(idoc, range, anno);
  return true;
}

const commonSuffixLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; };
const commonPrefixLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

// Anchor a saved quote back into the live deck. Strategy, most-trusted first:
//  1. exact text match; if it appears more than once, disambiguate by how well
//     the saved prefix/suffix line up around each occurrence (pick best score).
//  2. whitespace-normalised match — survives a re-uploaded/reflowed deck whose
//     spacing changed but whose words didn't.
function locateQuote(idoc, root, anchor) {
  const quote = anchor.quote || "";
  if (!quote) return null;
  const walker = idoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let full = "";
  while (walker.nextNode()) { const n = walker.currentNode; nodes.push([n, full.length]); full += n.nodeValue; }
  const at = (pos) => { for (const [n, off] of nodes) if (pos <= off + n.nodeValue.length) return [n, pos - off]; const l = nodes[nodes.length - 1]; return [l[0], l[0].nodeValue.length]; };
  const mkRange = (start, end) => { const [sn, so] = at(start), [en, eo] = at(end); const r = idoc.createRange(); r.setStart(sn, so); r.setEnd(en, eo); return r; };

  // 1) exact occurrences
  const hits = [];
  for (let p = full.indexOf(quote); p >= 0; p = full.indexOf(quote, p + 1)) hits.push(p);
  if (hits.length === 1) return mkRange(hits[0], hits[0] + quote.length);
  if (hits.length > 1) {
    const pre = anchor.prefix || "", suf = anchor.suffix || "";
    let best = hits[0], bestScore = -1;
    for (const p of hits) {
      const before = full.slice(Math.max(0, p - pre.length), p);
      const after = full.slice(p + quote.length, p + quote.length + suf.length);
      const score = commonSuffixLen(before, pre) + commonPrefixLen(after, suf);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return mkRange(best, best + quote.length);
  }

  // 2) whitespace-normalised fallback (deck spacing changed since the anno was saved)
  const normChars = [], map = [];   // map[i] = original index of normalised char i
  for (let i = 0; i < full.length; i++) {
    const c = full[i];
    if (/\s/.test(c)) { if (normChars.length && normChars[normChars.length - 1] !== " ") { normChars.push(" "); map.push(i); } }
    else { normChars.push(c); map.push(i); }
  }
  const normFull = normChars.join("");
  const nq = quote.replace(/\s+/g, " ").trim();
  if (nq) {
    const np = normFull.indexOf(nq);
    if (np >= 0) return mkRange(map[np], map[Math.min(np + nq.length - 1, map.length - 1)] + 1);
  }
  return null;
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
  let missed = 0;
  (state.graph.annotations || []).filter((a) => a.date === state.date)
    .forEach((a) => { if (a.anchor && !highlight(a)) missed++; });
  if (missed) { setStatus(`${missed} 条标注未能在正文里定位（正文可能已更新，标注仍在右栏列表）`); setTimeout(() => setStatus(""), 4000); }
}

// ----------------------------------------------------------------- persistence
async function saveAnno(anno) {
  setStatus("保存中…");
  const res = await api.post("/api/reader/annotate", { annotation: anno });
  if (res && res.error) {
    setStatus("保存失败"); toast("标注没存上：" + res.error + "（卡片还在，可重试）");
    setTimeout(() => setStatus(""), 2500);
    return false;
  }
  await refreshGraph();
  renderAnnoList();
  setStatus("已保存");
  setTimeout(() => setStatus(""), 1200);
  return true;
}
async function removeAnno(anno, cardEl) {
  const res = await api.post("/api/reader/annotate", { delete: anno.id });
  if (res && res.error) { toast("删除失败：" + res.error); return; }
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
  const KIND = { note: "笔记", tag: "标签", term: "术语", ask: "问CC", translate: "翻译", task: "📌 任务" };
  const wrap = $("#anno-list");
  wrap.innerHTML = "";
  if (!list.length) { wrap.innerHTML = `<p class="hint">这天还没有标注。</p>`; return; }
  list.forEach((a) => {
    const item = document.createElement("div");
    item.className = "anno-item"; item.dataset.id = a.id;
    item.innerHTML = `<span class="k kind-${a.kind}">${KIND[a.kind] || a.kind}</span>
      <p class="q">“${escapeHtml((a.anchor?.quote || "").slice(0, 90))}”</p>
      <div class="anno-body"></div>`;
    // click anywhere in the item jumps to the highlight — except on interactive controls
    item.onclick = (e) => { if (e.target.closest("button, input, textarea")) return; scrollToAnno(a.id); };
    const body = item.querySelector(".anno-body");
    if (a.kind === "note" || a.kind === "tag") {
      mountEditable(a, body, item, false);                         // editable across refreshes/reloads
    } else {
      body.innerHTML =
        (a.payload ? `<p class="p">${escapeHtml(a.payload)}</p>` : "") +
        (a.answer ? `<p class="p ans">${escapeHtml(a.answer.slice(0, 160))}${a.answer.length > 160 ? "…" : ""}</p>` : "") +
        `<div class="row"><button class="memo">存手帐</button><button class="danger">删除</button></div>`;
      body.querySelector(".memo").onclick = (e) => toMemo(memoText(a), e.target, a.kind === "task" ? ["小钻风", "任务"] : ["小钻风"]);
      body.querySelector(".danger").onclick = () => { if (confirm("删除这条标注？")) removeAnno(a, item); };
    }
    wrap.appendChild(item);
  });
}

// The deck iframe is sized to its full content height (no internal scroll) — the
// scroll happens on #reading. So scrollIntoView *inside* the iframe does nothing;
// we map the mark's position into #reading's scroll space and scroll there.
function scrollToAnno(id) {
  const iframe = $("#deck"), reading = $("#reading");
  const idoc = iframe.contentDocument;
  const m = idoc && idoc.querySelector(`.xzf-anno[data-anno-id="${id}"]`);
  if (!m) { toast("这条标注没在当前正文里（正文可能已更新）"); return; }
  const markTop = m.getBoundingClientRect().top;                       // px from iframe top (iframe isn't internally scrolled)
  const offsetInReading = (iframe.getBoundingClientRect().top - reading.getBoundingClientRect().top) + reading.scrollTop;
  const target = offsetInReading + markTop - reading.clientHeight / 2; // center the mark
  reading.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  m.classList.add("xzf-flash"); setTimeout(() => m.classList.remove("xzf-flash"), 1400);
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

boot();
