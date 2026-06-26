/* 小钻风 · 演变追踪 — 选一家公司，按日期看它被哪些 post 提及、Yibo/Claude 的立场怎么变。
   （原知识图谱的实体网络/观点/问答视图已移除，只保留这一个视图；只收录 type=company 的实体。） */
const $ = (s) => document.querySelector(s);
const api = { get: (u) => fetch(u).then((r) => r.json()) };
let G = null;
const isCompany = (e) => e && e.type === "company";

async function boot() {
  G = await api.get("/api/reader/graph");
  buildTimeline();
}

function buildTimeline() {
  // only companies; rank by trackable activity (posts mentioning + opinions about)
  const activity = (e) =>
    G.posts.filter((p) => (e.mentions || []).includes(p.id) || (p.mentions || []).includes(e.id)).length +
    G.opinions.filter((o) => (o.about || []).includes(e.id)).length;
  const ents = G.entities.filter(isCompany).map((e) => ({ e, n: activity(e) })).sort((a, b) => b.n - a.n);
  if (!ents.length) { $("#timeline-view").innerHTML = `<p class="hint">还没有可追踪的公司。读几篇导读、抽取入图谱后再来。</p>`; return; }
  const opts = ents.map(({ e, n }) => `<option value="${e.id}">${e.canonical_name} (${n})</option>`).join("");
  $("#timeline-view").innerHTML =
    `<div class="track-bar">追踪公司：<select id="track-entity">${opts}</select>
       <span class="track-hint">看这家公司跨天怎么被提及、Yibo／Claude 的立场怎么变。</span></div>
     <div id="track-body"></div>`;
  const sel = $("#track-entity");
  sel.onchange = () => renderTrack(sel.value);
  renderTrack(ents[0].e.id);   // default: most-active company
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

  // related — only other companies, so clicking a chip always lands on a tracked entity
  const rels = G.relations.filter((r) => r.src === e.id || r.dst === e.id);
  const seen = new Set();
  const relChips = rels.map((r) => {
    const other = r.src === e.id ? r.dst : r.src;
    const oe = G.entities.find((x) => x.id === other);
    if (!isCompany(oe) || seen.has(other)) return "";
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
       <div class="type">company${e.aliases && e.aliases.length ? ` · aka ${e.aliases.join(", ")}` : ""}</div>
       <h3>${e.canonical_name}</h3>
       ${e.description ? `<p>${e.description}</p>` : ""}
       <div class="track-meta">提及 ${mentioned.length} 篇 · 观点 ${opins.length} 条 · ${span}</div>
       ${relChips ? `<div class="track-rels"><b>关联公司</b> ${relChips}</div>` : ""}
     </div>${dayHtml}`;
  $("#track-body").querySelectorAll(".chip[data-ent]").forEach((c) => (c.onclick = () => {
    const t = c.dataset.ent;
    if (G.entities.some((x) => x.id === t)) { $("#track-entity").value = t; renderTrack(t); }
  }));
}

boot();
