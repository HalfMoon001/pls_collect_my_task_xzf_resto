/* 小钻风 · 演变追踪 — 选一家公司，按日期看它被哪些 post 提及、Yibo/Claude 的立场怎么变。
   （原知识图谱的实体网络/观点/问答视图已移除，只保留这一个视图；只收录 type=company 的实体。） */
const $ = (s) => document.querySelector(s);
const api = {
  get: async (u) => { try { return await (await fetch(u)).json(); } catch (e) { return { error: String(e.message || e) }; } },
  post: async (u, b) => { try { return await (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(); } catch (e) { return { error: String(e.message || e) }; } },
};
let G = null;
const isCompany = (e) => e && e.type === "company";

async function boot() {
  G = await api.get("/api/reader/graph");
  buildTimeline();
  bindTranslate();
}

// ----------------------------------------------------------- 划词翻译副栏
let txToken = 0;
function bindTranslate() {
  // translate whatever the user selects in the content column (not the side panel)
  $("#content").addEventListener("mouseup", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 1) return;
    autoTranslate(text);
  });
}

async function autoTranslate(text) {
  const ENG = { fast: "本地·快", fine: "本地·精", cc: "CC·精翻" };
  $(".tx-empty").style.display = "none";
  const src = $(".tx-src"), out = $(".tx-out"), eng = $(".tx-eng"), row = $(".tx-row");
  src.hidden = false; src.textContent = text;
  const token = ++txToken;
  const render = async (mode) => {
    out.innerHTML = `<span class="spin"></span>`; eng.textContent = "";
    const res = await api.post("/api/reader/translate", { text, mode });
    if (token !== txToken) return;   // superseded by a newer selection
    out.textContent = (res && res.translation) || ("翻译失败：" + ((res && res.error) || "?"));
    eng.textContent = (ENG[res.engine] || res.engine || "") + (res.engine === "cc" && mode !== "cc" ? "（本地不可用）" : "");
    row._tx = res && res.translation;
  };
  await render("fast");
  row.hidden = false;
  $(".tx-fine").onclick = () => render("fine");
  const memo = $(".tx-memo"); memo.disabled = false; memo.textContent = "存进手帐";
  memo.onclick = () => toMemo(`【小钻风译文】${text}\n— ${row._tx || ""}`, memo);
}

async function toMemo(content, btn) {
  if (!content) return;
  const res = await api.post("/api/memos", { content, tags: ["小钻风"] });
  if (res && res.error) { toast("存手帐失败：" + res.error); return; }
  if (btn) { btn.textContent = "✓ 已存手帐"; btn.disabled = true; }
  toast("已存进手帐 · 标签 #小钻风");
}
function toast(msg) {
  let t = $("#xzf-toast");
  if (!t) { t = document.createElement("div"); t.id = "xzf-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

// ignore list (companies the user doesn't want to see) — persisted per-browser
const IGNORE_KEY = "xzf-track-ignored";
const loadIgnored = () => { try { return new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) || "[]")); } catch { return new Set(); } };
const saveIgnored = (set) => localStorage.setItem(IGNORE_KEY, JSON.stringify([...set]));
function ignoreCompany(id) { const s = loadIgnored(); s.add(id); saveIgnored(s); buildTimeline(); }
function unignoreCompany(id) { const s = loadIgnored(); s.delete(id); saveIgnored(s); buildTimeline(); }

function buildTimeline() {
  const activity = (e) =>
    G.posts.filter((p) => (e.mentions || []).includes(p.id) || (p.mentions || []).includes(e.id)).length +
    G.opinions.filter((o) => (o.about || []).includes(e.id)).length;
  const ignored = loadIgnored();
  const allComps = G.entities.filter(isCompany);
  const ents = allComps.filter((e) => !ignored.has(e.id)).map((e) => ({ e, n: activity(e) })).sort((a, b) => b.n - a.n);
  const ignoredComps = allComps.filter((e) => ignored.has(e.id));

  if (!allComps.length) { $("#timeline-view").innerHTML = `<p class="hint">还没有可追踪的公司。读几篇导读、抽取入图谱后再来。</p>`; return; }

  const opts = ents.map(({ e, n }) => `<option value="${e.id}">${e.canonical_name} (${n})</option>`).join("");
  $("#timeline-view").innerHTML =
    `<div class="track-bar">追踪公司：<select id="track-entity"${ents.length ? "" : " disabled"}>${opts || `<option>（全部已忽略）</option>`}</select>
       ${ignoredComps.length ? `<button id="ignored-toggle" class="linkbtn">已忽略 ${ignoredComps.length} ▾</button>` : ""}
       <span class="track-hint">看这家公司跨天怎么被提及、Yibo／Claude 的立场怎么变。</span></div>
     <div id="ignored-panel" hidden></div>
     <div id="track-body"></div>`;

  if (ignoredComps.length) {
    $("#ignored-toggle").onclick = () => { const p = $("#ignored-panel"); p.hidden = !p.hidden; };
    $("#ignored-panel").innerHTML =
      `<div class="ignored-list">已忽略（点加回）：${ignoredComps.map((e) => `<span class="chip ignored" data-add="${e.id}">${e.canonical_name} <b>+ 加回</b></span>`).join("")}</div>`;
    $("#ignored-panel").querySelectorAll("[data-add]").forEach((c) => (c.onclick = () => unignoreCompany(c.dataset.add)));
  }

  if (!ents.length) { $("#track-body").innerHTML = `<p class="hint">公司都被你忽略了。点上面「已忽略」把想看的加回来。</p>`; return; }
  const sel = $("#track-entity");
  sel.onchange = () => renderTrack(sel.value);
  renderTrack(ents[0].e.id);   // default: most-active visible company
}

function renderTrack(id) {
  const e = G.entities.find((x) => x.id === id);
  if (!e) { $("#track-body").innerHTML = `<p class="hint">没有这个公司了。</p>`; return; }
  const mentioned = G.posts.filter((p) => (e.mentions || []).includes(p.id) || (p.mentions || []).includes(e.id));
  const opins = G.opinions.filter((o) => (o.about || []).includes(e.id));
  const byDate = {};
  const bucket = (d) => (byDate[d] = byDate[d] || { posts: [], ops: [] });
  mentioned.forEach((p) => bucket(p.date).posts.push(p));
  opins.forEach((o) => bucket(o.date).ops.push(o));
  const dates = Object.keys(byDate).sort();   // oldest → newest, read the evolution forward

  // related — only other (non-ignored) companies, so a chip always lands on a tracked one
  const ignored = loadIgnored();
  const rels = G.relations.filter((r) => r.src === e.id || r.dst === e.id);
  const seen = new Set();
  const relChips = rels.map((r) => {
    const other = r.src === e.id ? r.dst : r.src;
    const oe = G.entities.find((x) => x.id === other);
    if (!isCompany(oe) || ignored.has(other) || seen.has(other)) return "";
    seen.add(other);
    const thread = r.type === "same_thread_as";
    return `<span class="chip${thread ? " thread" : ""}" data-ent="${other}">${thread ? "🔗 " : ""}${oe.canonical_name}</span>`;
  }).join("");
  const span = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : (e.first_seen || "—");

  const dayHtml = dates.length ? dates.map((d) => {
    const { posts, ops } = byDate[d];
    return `<div class="tl-day"><h2>${d}</h2>
      ${posts.map((p) => `<div class="tl-post"><span class="cat">${p.category || ""}${p.is_long_read ? " · long read" : ""}</span><h4>${p.headline || ""}</h4><div class="sum">${p.body_summary || ""}</div></div>`).join("")}
      ${ops.map((o) => `<div class="op ${o.holder}"><b>${o.label || o.holder}${o.stance ? ` · ${o.stance}` : ""}:</b> ${o.text || ""}</div>`).join("")}
    </div>`;
  }).join("") : `<p class="hint">这家公司还没有可追踪的提及或观点。</p>`;

  $("#track-body").innerHTML =
    `<div class="track-head">
       <button class="ignore-btn" title="不再在列表里显示这家公司">🙈 忽略这家</button>
       <div class="type">company${e.aliases && e.aliases.length ? ` · aka ${e.aliases.join(", ")}` : ""}</div>
       <h3>${e.canonical_name}</h3>
       ${e.description ? `<p>${e.description}</p>` : ""}
       <div class="track-meta">提及 ${mentioned.length} 篇 · 观点 ${opins.length} 条 · ${span}</div>
       ${relChips ? `<div class="track-rels"><b>关联公司</b> ${relChips}</div>` : ""}
     </div>${dayHtml}`;
  $("#track-body .ignore-btn").onclick = () => ignoreCompany(e.id);
  $("#track-body").querySelectorAll(".chip[data-ent]").forEach((c) => (c.onclick = () => {
    const t = c.dataset.ent;
    if (G.entities.some((x) => x.id === t)) { $("#track-entity").value = t; renderTrack(t); }
  }));
}

boot();
