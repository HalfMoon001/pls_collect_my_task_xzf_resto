/* 小钻风 · 学习页 — 术语表 + CC 出题小测。素材 = 我标注的术语 + 我的标注。 */
const $ = (s) => document.querySelector(s);
const api = {
  get: (u) => fetch(u).then((r) => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
};
let G = null;
const esc = (s) => (s || "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

async function boot() {
  G = await api.get("/api/reader/graph");
  renderGlossary("");
  renderQuizHint();
  $("#search").oninput = (e) => renderGlossary(e.target.value.trim());
  $("#show-concepts").onchange = () => renderGlossary($("#search").value.trim());
  document.querySelectorAll(".tabbtn").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabbtn").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === b.dataset.view));
  }));
  $("#quiz-go").onclick = startQuiz;
}

// --------- glossary: my term annotations (+ optional graph concepts) ---------
function myTerms() {
  // term annotations the user created (each: payload=term, answer=definition)
  const byTerm = {};
  (G.annotations || []).filter((a) => a.kind === "term").forEach((a) => {
    const ent = (a.linked_entities || []).map((id) => G.entities.find((e) => e.id === id)).find(Boolean);
    const key = (a.payload || a.anchor?.quote || "").toLowerCase();
    byTerm[key] = {
      term: a.payload || a.anchor?.quote || "(术语)",
      def: a.answer || ent?.description || "",
      type: ent?.type || "term", aliases: ent?.aliases || [],
      date: a.date, post_id: a.post_id, source: "annotation",
    };
  });
  return Object.values(byTerm);
}
function conceptEntities() {
  const T = new Set(["concept", "benchmark", "framework"]);
  return G.entities.filter((e) => T.has(e.type)).map((e) => ({
    term: e.canonical_name, def: e.description, type: e.type, aliases: e.aliases || [],
    date: e.first_seen, post_id: (e.mentions || [])[0], source: "graph",
  }));
}

function renderGlossary(q) {
  let items = myTerms();
  if ($("#show-concepts").checked) {
    const have = new Set(items.map((i) => i.term.toLowerCase()));
    items = items.concat(conceptEntities().filter((c) => !have.has(c.term.toLowerCase())));
  }
  if (q) { const lq = q.toLowerCase(); items = items.filter((i) => (i.term + " " + i.def + " " + i.aliases.join(" ")).toLowerCase().includes(lq)); }
  items.sort((a, b) => a.term.localeCompare(b.term));
  const mine = myTerms().length;
  $("#gloss-count").textContent = `我标注的术语 ${mine} 个` + ($("#show-concepts").checked ? ` · 含图谱概念共 ${items.length} 个` : "");
  if (!items.length) {
    $("#gloss-list").innerHTML = `<div class="empty">还没有标注过术语。<br>去<a href="/reader/">阅读器</a>里选中一个术语点 <b>📖 术语</b>，CC 会生成解释并自动收进这里。</div>`;
    return;
  }
  const headline = (pid) => { const p = G.posts.find((x) => x.id === pid); return p ? `${p.date} · ${p.headline}` : ""; };
  $("#gloss-list").innerHTML = items.map((i) => `
    <div class="term">
      <h3>${esc(i.term)} <span class="type">${i.type}</span>${i.aliases.length ? `<span class="alias">aka ${esc(i.aliases.join(", "))}</span>` : ""}</h3>
      <p class="def">${esc(i.def) || "<span style='color:#bbb'>（暂无定义）</span>"}</p>
      ${i.post_id ? `<div class="meta">出处：<a href="/reader/?date=${i.date}" title="${esc(headline(i.post_id))}">${esc(headline(i.post_id))}</a></div>` : (i.date ? `<div class="meta">${i.date}</div>` : "")}
    </div>`).join("");
}

// --------------------- quiz: terms + my annotations -------------------------
function quizPool() {
  const out = [];
  (G.annotations || []).forEach((a) => {
    if (a.kind === "term") out.push({ id: a.id, kind: "term", term: a.payload || a.anchor?.quote, definition: a.answer || "", quote: a.anchor?.quote || "", note: "" });
    else if (a.kind === "note" && a.payload) out.push({ id: a.id, kind: "note", term: "", definition: "", quote: a.anchor?.quote || "", note: a.payload });
    else if (a.kind === "tag" && a.payload) out.push({ id: a.id, kind: "tag", term: a.payload, definition: "", quote: a.anchor?.quote || "", note: "" });
  });
  return out;
}
function renderQuizHint() {
  const n = quizPool().length;
  $("#quiz-hint").textContent = n ? `素材池：${n} 条（术语 + 你的标注）` : "还没有可出题的素材——先去标注些术语/笔记。";
  $("#quiz-go").disabled = n === 0;
}

let quizState = [];
async function startQuiz() {
  const pool = quizPool();
  if (!pool.length) return;
  const n = +$("#quiz-n").value;
  $("#quiz-go").disabled = true;
  $("#quiz-body").innerHTML = `<div class="qcard"><span class="spin"></span> CC 正在出题…</div>`;
  const res = await api.post("/api/reader/quiz_make", { pool, n });
  $("#quiz-go").disabled = false;
  const qs = (res.questions || []).filter((q) => q && q.question);
  if (!qs.length) { $("#quiz-body").innerHTML = `<div class="empty">出题失败，再试一次。</div>`; return; }
  const refOf = (id) => { const p = pool.find((x) => x.id === id); return p ? (p.definition || p.note || p.quote || p.term) : ""; };
  quizState = qs.map((q) => ({ id: q.id, question: q.question, reference: refOf(q.id) }));
  $("#quiz-body").innerHTML = quizState.map((q, i) => `
    <div class="qcard" data-id="${q.id}">
      <div class="qn">第 ${i + 1} 题</div>
      <div class="q">${esc(q.question)}</div>
      <textarea placeholder="用自己的话作答…"></textarea>
      <div class="grade"></div>
    </div>`).join("") + `
    <div id="quiz-actions"><button id="quiz-submit">提交批改</button><span id="score"></span></div>`;
  $("#quiz-submit").onclick = submitQuiz;
}

async function submitQuiz() {
  const cards = [...document.querySelectorAll(".qcard[data-id]")];
  const items = cards.map((c) => {
    const q = quizState.find((x) => x.id === c.dataset.id);
    return { id: c.dataset.id, question: q.question, reference: q.reference, answer: c.querySelector("textarea").value.trim() };
  });
  if (items.every((i) => !i.answer)) { alert("先答一题再提交～"); return; }
  $("#quiz-submit").disabled = true;
  $("#score").innerHTML = `<span class="spin"></span> CC 批改中…`;
  const res = await api.post("/api/reader/quiz_grade", { items });
  $("#quiz-submit").disabled = false;
  const results = res.results || [];
  let correct = 0;
  cards.forEach((c) => {
    const r = results.find((x) => x.id === c.dataset.id) || {};
    if (r.verdict === "对") correct += 1; else if (r.verdict === "部分对") correct += 0.5;
    const g = c.querySelector(".grade");
    g.className = "grade show";
    g.innerHTML = `<span class="verdict v-${esc(r.verdict || "?")}">${esc(r.verdict || "?")}</span>
      <p class="comment">${esc(r.comment || "")}</p>
      ${r.correct ? `<div class="correct">参考答案：${esc(r.correct)}</div>` : ""}`;
  });
  $("#score").textContent = `得分 ${correct} / ${cards.length}`;
}

boot();
