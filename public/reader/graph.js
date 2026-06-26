/* 小钻风 · 知识图谱视图 — 实体网络 / 时间线 / 观点 / 问答 (Cytoscape + vanilla). */
const $ = (s) => document.querySelector(s);
const api = {
  get: (u) => fetch(u).then((r) => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
};
let G = null, cy = null;
if (window.cytoscapeFcose) cytoscape.use(window.cytoscapeFcose);
// Layout cost scales with graph size: small graphs get the high-quality solver;
// as the graph grows across days, trade a little layout quality for responsiveness
// so it doesn't freeze the tab.
function layoutFor(n) {
  const big = n > 120, huge = n > 300;
  return {
    name: window.cytoscapeFcose ? "fcose" : "cose",
    quality: huge ? "draft" : big ? "default" : "proof",
    animate: false, randomize: true,
    nodeDimensionsIncludeLabels: true,   // space nodes by their LABEL box → no overlap
    idealEdgeLength: 120, nodeSeparation: 110, nodeRepulsion: 9000,
    gravity: 0.25, gravityRange: 3.0, packComponents: true,
    numIter: huge ? 1000 : big ? 1500 : 2500,
    fit: true, padding: 50,              // auto-fit the whole graph into the canvas
  };
}

const TYPE_COLOR = {
  company: "#0F2147", person: "#B5252B", product: "#2f7d4f", paper: "#8d7bbd",
  concept: "#c98a1a", benchmark: "#3a86a8", framework: "#5b6b8c", tool: "#6b8c5b",
  source: "#999", project: "#d4682f",
};

async function boot() {
  G = await api.get("/api/reader/graph");
  buildTypeFilters();
  buildCy();
  buildTimeline();
  buildOpinions();
  bindTabs();
  $("#search").oninput = (e) => searchFocus(e.target.value.trim());
  $("#ask-go").onclick = ask;
  $("#ask-input").onkeydown = (e) => { if (e.key === "Enter") ask(); };
}

// ----------------------------------------------------------------- entity net
function buildCy() {
  const opByEntity = {};
  G.opinions.forEach((o) => (o.about || []).forEach((e) => (opByEntity[e] = opByEntity[e] || []).push(o)));
  const nodes = G.entities.map((e) => ({
    data: { id: e.id, label: e.canonical_name, type: e.type, deg: e.mentions ? e.mentions.length : 1, e },
  }));
  const edges = G.relations.filter((r) => nodeExists(r.src) && nodeExists(r.dst)).map((r) => ({
    data: { id: r.id, source: r.src, target: r.dst, label: r.type, thread: r.type === "same_thread_as", r },
  }));
  cy = cytoscape({
    container: $("#cy"),
    elements: [...nodes, ...edges],
    style: [
      { selector: "node", style: { "background-color": (n) => TYPE_COLOR[n.data("type")] || "#666", label: "data(label)", "font-size": 11, color: "#222", "text-wrap": "wrap", "text-max-width": 110, "text-valign": "bottom", "text-margin-y": 3, width: (n) => 16 + 4 * Math.min(8, n.data("deg")), height: (n) => 16 + 4 * Math.min(8, n.data("deg")) } },
      { selector: "edge", style: { width: 1.3, "line-color": "#bbb", "target-arrow-color": "#bbb", "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": "bezier", label: "data(label)", "font-size": 8, color: "#999", "text-rotation": "autorotate", "text-background-color": "#f3f0e9", "text-background-opacity": 1, "text-background-padding": 1 } },
      { selector: "edge[?thread]", style: { "line-color": "#B5252B", "line-style": "dashed", "target-arrow-color": "#B5252B", width: 2, color: "#B5252B" } },
      { selector: ".faded", style: { opacity: 0.12 } },
      { selector: ".hi", style: { "border-width": 3, "border-color": "#B5252B" } },
    ],
    layout: layoutFor(nodes.length),
    wheelSensitivity: 0.25,
  });
  cy.on("tap", "node", (evt) => showEntity(evt.target.data("e"), opByEntity));
  cy.on("tap", (evt) => { if (evt.target === cy) { cy.elements().removeClass("faded hi"); } });
}
const nodeExists = (id) => G.entities.some((e) => e.id === id);

function showEntity(e, opByEntity) {
  cy.elements().removeClass("faded hi");
  const node = cy.$id(e.id);
  const neighborhood = node.closedNeighborhood();
  cy.elements().not(neighborhood).addClass("faded");
  node.addClass("hi");
  const rels = G.relations.filter((r) => r.src === e.id || r.dst === e.id);
  const relHtml = rels.map((r) => {
    const other = r.src === e.id ? r.dst : r.src;
    const dir = r.src === e.id ? `—${r.type}→` : `←${r.type}—`;
    const oe = G.entities.find((x) => x.id === other);
    return `<div>${dir} <span class="chip" data-ent="${other}">${oe ? oe.canonical_name : other}</span>${r.type === "same_thread_as" ? " 🔗跨天" : ""}</div>`;
  }).join("");
  const posts = (e.mentions || []).map((pid) => G.posts.find((p) => p.id === pid)).filter(Boolean);
  const postHtml = posts.map((p) => `<div class="chip" title="${p.date}">${p.date} · ${p.headline.slice(0, 40)}</div>`).join("");
  const ops = opByEntity[e.id] || [];
  const opHtml = ops.map((o) => `<div class="op ${o.holder}"><span class="h">${o.label} · ${o.date}</span><br>${o.text}</div>`).join("");
  $("#detail").innerHTML = `
    <div class="type">${e.type}</div><h3>${e.canonical_name}</h3>
    ${e.aliases && e.aliases.length ? `<div class="type">aka ${e.aliases.join(", ")}</div>` : ""}
    <p>${e.description || ""}</p>
    ${relHtml ? `<div class="sec"><b>关系 (${rels.length})</b>${relHtml}</div>` : ""}
    ${postHtml ? `<div class="sec"><b>出处 · ${posts.length} 篇</b><br>${postHtml}</div>` : ""}
    ${opHtml ? `<div class="sec"><b>相关观点 (${ops.length})</b>${opHtml}</div>` : ""}`;
  $("#detail").querySelectorAll(".chip[data-ent]").forEach((c) => (c.onclick = () => {
    const t = G.entities.find((x) => x.id === c.dataset.ent); if (t) { showEntity(t, opByEntity); cy.center(cy.$id(t.id)); }
  }));
}

function searchFocus(q) {
  if (!q) { cy.elements().removeClass("faded hi"); return; }
  const m = cy.nodes().filter((n) => n.data("label").toLowerCase().includes(q.toLowerCase()));
  cy.elements().addClass("faded"); m.removeClass("faded").addClass("hi"); m.connectedEdges().removeClass("faded");
  if (m.length) cy.animate({ fit: { eles: m, padding: 80 } }, { duration: 300 });
}

function buildTypeFilters() {
  const types = [...new Set(G.entities.map((e) => e.type))];
  $("#type-filters").innerHTML = types.map((t) => `<label><input type="checkbox" checked data-t="${t}"><span style="color:${TYPE_COLOR[t]||'#fff'}">●</span>${t}</label>`).join("");
  $("#type-filters").querySelectorAll("input").forEach((cb) => (cb.onchange = () => {
    const on = new Set([...$("#type-filters").querySelectorAll("input:checked")].map((x) => x.dataset.t));
    cy.nodes().forEach((n) => n.style("display", on.has(n.data("type")) ? "element" : "none"));
  }));
}

// ----------------------------------------------------------------- timeline
function buildTimeline() {
  const days = [...new Set(G.posts.map((p) => p.date))].sort();
  const opByPost = {};
  G.opinions.forEach((o) => (opByPost[o.post_id] = opByPost[o.post_id] || []).push(o));
  $("#timeline-view").innerHTML = days.map((d) => {
    const posts = G.posts.filter((p) => p.date === d).sort((a, b) => a.slide_index - b.slide_index);
    return `<div class="tl-day"><h2>${d}</h2>${posts.map((p) => `
      <div class="tl-post">
        <span class="cat">${p.category || ""}${p.is_long_read ? " · long read" : ""}</span>
        <h4>${p.headline}</h4>
        <div class="sum">${p.body_summary || ""}</div>
        ${(opByPost[p.id] || []).map((o) => `<div class="op ${o.holder}"><b>${o.label}:</b> ${o.text}</div>`).join("")}
      </div>`).join("")}</div>`;
  }).join("");
}

// ----------------------------------------------------------------- opinions
function buildOpinions() {
  const ops = G.opinions.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const entName = (id) => { const e = G.entities.find((x) => x.id === id); return e ? e.canonical_name : id; };
  $("#opinions-view").innerHTML = `<div style="max-width:900px">${ops.map((o) => `
    <div class="opcard ${o.holder}">
      <div class="meta">${o.holder.toUpperCase()} · ${o.label} · ${o.date}<span class="stance">${o.stance || ""}</span></div>
      <p>${o.text}</p>
      <div>${(o.about || []).map((a) => `<span class="chip">${entName(a)}</span>`).join("")}</div>
    </div>`).join("")}</div>`;
}

// ----------------------------------------------------------------- ask
async function ask() {
  const q = $("#ask-input").value.trim(); if (!q) return;
  const card = document.createElement("div"); card.className = "qa";
  card.innerHTML = `<div class="q">${q}</div><div class="a"><span class="spin"></span> 基于图谱检索中…</div>`;
  $("#qa-list").prepend(card); $("#ask-input").value = "";
  const res = await api.post("/api/reader/ask", { question: q });
  card.querySelector(".a").textContent = res.answer || ("失败：" + (res.error || "?"));
}

// ----------------------------------------------------------------- tabs
function bindTabs() {
  document.querySelectorAll(".tabbtn").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabbtn").forEach((x) => x.classList.toggle("active", x === b));
    const v = b.dataset.view;
    $("#cy").classList.toggle("active", v === "cy");
    document.querySelectorAll(".view").forEach((p) => p.classList.toggle("active", p.id === v));
    if (v === "cy" && cy) { cy.resize(); cy.fit(undefined, 50); }
  }));
}

boot();
