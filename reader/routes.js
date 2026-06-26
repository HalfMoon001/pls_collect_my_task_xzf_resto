// routes.js — mounts the 小钻风 reader feature onto the shared Express app.
// Pages live at /reader, /reader/graph, /reader/learn (static assets under
// public/reader/ are served by the app's existing express.static). API lives
// under /api/reader/*. Reasoning endpoints reuse the host app's callClaude so
// the whole app shares ONE global CC lock ("CC 一次只干一件事").

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { makeGraphStore, slug } = require('./graph-store');
const parseDeck = require('./parse-deck');
const tx = require('./translate');

function extractJSON(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('no JSON found in claude output');
}

function mountReader(app, opts) {
  const { callClaude, dataDir, seedDir, publicDir } = opts;
  const readerData = path.join(dataDir, 'reader');
  const graphDir = path.join(readerData, 'graph');
  const deckDir = process.env.READER_DECK_DIR || path.join(readerData, 'decks');
  const annoLogDir = path.join(readerData, 'annotations');

  // --- first-run seeding ---
  function ensureReaderData() {
    fs.mkdirSync(graphDir, { recursive: true });
    fs.mkdirSync(deckDir, { recursive: true });
    fs.mkdirSync(annoLogDir, { recursive: true });
    for (const f of ['posts.json', 'entities.json', 'relations.json', 'opinions.json', 'annotations.json']) {
      const dst = path.join(graphDir, f);
      if (!fs.existsSync(dst)) {
        const src = path.join(seedDir, 'graph', f);
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        else fs.writeFileSync(dst, JSON.stringify({ schema_version: 1, [f.replace('.json', '')]: [] }, null, 2));
      }
    }
    // seed sample decks only if the deck folder is empty
    try {
      const seedDecks = path.join(seedDir, 'decks');
      if (fs.existsSync(seedDecks) && fs.readdirSync(deckDir).filter((x) => x.endsWith('.html')).length === 0) {
        for (const f of fs.readdirSync(seedDecks)) if (f.endsWith('.html')) fs.copyFileSync(path.join(seedDecks, f), path.join(deckDir, f));
      }
    } catch {}
  }
  ensureReaderData();

  const G = makeGraphStore(graphDir, annoLogDir);

  // --- deck discovery ---
  function listDecks() {
    const seen = {};
    let files = [];
    try { files = fs.readdirSync(deckDir); } catch {}
    for (const fn of files.sort()) {
      if (!fn.toLowerCase().endsWith('.html')) continue;
      const m = fn.match(/(\d{4}-\d{2}-\d{2})/);
      const date = m ? m[1] : fn;
      const full = path.join(deckDir, fn);
      if (!seen[date] || fs.statSync(full).size > fs.statSync(seen[date]).size) seen[date] = full;
    }
    return Object.keys(seen).sort().reverse().map((date) => ({ date, file: seen[date] }));
  }
  function deckPath(date) {
    const d = listDecks().find((x) => x.date === date);
    return d ? d.file : null;
  }

  // --- translation cache (LRU-capped so a long-running server doesn't grow unbounded) ---
  const txCache = new Map();
  const TX_CACHE_MAX = 500;
  function txCacheSet(key, val) {
    if (txCache.size >= TX_CACHE_MAX) txCache.delete(txCache.keys().next().value);  // evict oldest
    txCache.set(key, val);
  }

  // --- helper: run a CC reasoning endpoint, mapping the busy lock to 409 ---
  async function ccGuard(res, fn) {
    try {
      res.json(await fn());
    } catch (err) {
      const msg = String(err && err.message || err);
      if (msg.startsWith('CC_BUSY:')) {
        return res.status(409).json({ error: `CC 正在忙「${msg.replace('CC_BUSY:', '')}」，等它忙完吧～`, busy: true });
      }
      res.status(500).json({ error: msg });
    }
  }

  // ============================ pages ============================
  const page = (f) => (req, res) => res.sendFile(path.join(publicDir, 'reader', f));
  app.get('/reader', page('index.html'));
  app.get('/reader/', page('index.html'));
  app.get('/reader/graph', page('graph.html'));
  app.get('/reader/learn', page('learn.html'));

  // ============================ GET api ============================
  app.get('/api/reader/decks', (req, res) => res.json({ decks: listDecks().map((d) => ({ date: d.date, file: path.basename(d.file) })) }));
  app.get('/api/reader/graph', (req, res) => res.json(G.blob()));
  app.get('/api/reader/deck_raw', (req, res) => {
    const p = deckPath(req.query.date);
    if (!p) return res.status(404).json({ error: 'no deck' });
    res.type('html').send(fs.readFileSync(p));
  });
  app.get('/api/reader/translate/status', async (req, res) => res.json(await tx.status()));

  // upload a daily deck HTML into the deck folder. The deck's own date is the source
  // of truth: prefer the date in its <title> ("Hot from Kitchen — YYYY-MM-DD"), then
  // any date in the content, then the filename, then today. We then save it named by
  // that resolved date so the deck list (which reads the date off the filename) agrees.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  app.post('/api/reader/upload', upload.single('deck'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '没有文件' });
      const orig = req.file.originalname || 'deck.html';
      if (!/\.html?$/i.test(orig)) return res.status(400).json({ error: '请上传 .html 文件' });
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const html = req.file.buffer.toString('utf-8');
      const titleM = html.match(/Hot from Kitchen[^0-9]{0,8}(\d{4}-\d{2}-\d{2})/i);
      const contentM = html.match(/(\d{4}-\d{2}-\d{2})/);
      const nameM = orig.match(/(\d{4}-\d{2}-\d{2})/);
      const date = (req.body && req.body.date) || (titleM && titleM[1]) || (nameM && nameM[1]) || (contentM && contentM[1]) || today;
      const dateGuessed = !((req.body && req.body.date) || titleM || nameM || contentM);
      const safe = `${date}.html`;   // canonical name = resolved date → filename/content/list all agree
      const target = path.join(deckDir, safe);
      // safety: a date-less deck must never silently overwrite an existing day's deck
      if (dateGuessed && fs.existsSync(target)) {
        return res.status(409).json({ error: `导读里没找到日期，按今天 ${date} 会覆盖已有导读。请在文件名或 <title> 里加上 YYYY-MM-DD 再传。` });
      }
      fs.writeFileSync(target, req.file.buffer);
      res.json({ ok: true, date, file: safe, dateGuessed, dateSource: (req.body && req.body.date) ? 'manual' : titleM ? 'title' : nameM ? 'filename' : contentM ? 'content' : 'today' });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // POST /api/reader/translate/pull — stream ollama pull progress (NDJSON)
  app.post('/api/reader/translate/pull', (req, res) => {
    const model = (req.body && req.body.model) || tx.MODEL_FAST;
    res.set('Content-Type', 'application/x-ndjson');
    tx.pullStream(model, res);
  });

  // ============================ POST api ============================
  app.post('/api/reader/translate', async (req, res) => {
    const text = (req.body.text || '').trim();
    const mode = req.body.mode || 'fast';
    if (!text) return res.json({ error: 'empty' });
    const key = mode + ' ' + text;
    if (txCache.has(key)) return res.json({ translation: txCache.get(key), engine: mode, cached: true });
    let out, engine;
    try {
      if (mode === 'cc') { out = await tx.ccTranslate(text, callClaude); engine = 'cc'; }
      else { out = await tx.localTranslate(text, tx.TX_MODELS[mode]); engine = mode; }
    } catch {
      try { out = await tx.ccTranslate(text, callClaude); engine = 'cc'; }
      catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }
    txCacheSet(key, out);
    res.json({ translation: out, engine });
  });

  app.post('/api/reader/define', (req, res) => ccGuard(res, async () => {
    const term = (req.body.term || '').trim();
    const context = (req.body.context || '').trim();
    const date = req.body.date || '';
    const postId = req.body.post_id || '';
    if (!term) return { error: 'empty' };
    const prompt =
      `你是 AI 行业知识助手。读者在一篇 AI 动态导读里选中了术语：「${term}」。\n` +
      `上下文片段：\n${context}\n\n` +
      '请输出一个 JSON 对象（只输出 JSON）：\n' +
      '{ "term": "规范名", "type": "company|person|product|paper|concept|benchmark|framework|tool|source|project",' +
      ' "definition_zh": "2-4 句中文解释，结合此处语境，说清它是什么、为什么重要", "aliases": ["别名"] }';
    const obj = extractJSON(await callClaude(prompt, '术语解释'));
    const ent = G.defineUpsert(obj, term, date, postId);
    return { definition: obj.definition_zh || '', entity: ent };
  }));

  app.post('/api/reader/ask', (req, res) => ccGuard(res, async () => {
    const q = (req.body.question || '').trim();
    const selection = (req.body.context || '').trim();
    if (!q) return { error: 'empty' };
    const g = G.blob();
    const entLines = g.entities.map((e) => `- ${e.canonical_name} (${e.type}): ${e.description || ''}`);
    const threadLines = g.relations.filter((r) => r.type === 'same_thread_as').map((r) => `- ${r.src} —${r.type}→ ${r.dst}: ${r.note || ''}`);
    const opLines = g.opinions.map((o) => `- [${o.holder}@${o.date}] ${(o.text || '').slice(0, 240)}`);
    const ctx =
      '已积累的知识图谱（实体）:\n' + entLines.join('\n') +
      '\n\n跨天线索:\n' + threadLines.join('\n') +
      '\n\n观点沉淀（Yibo / Claude）:\n' + opLines.join('\n');
    const prompt =
      '你是这位读者的 AI 动态知识助手。下面是他跨多天积累的导读知识图谱。' +
      '请只基于这些材料回答他的问题，用中文，简洁有据；如果材料里没有答案就直说。\n\n' +
      ctx + (selection ? `\n\n读者当前选中的片段：\n${selection}` : '') +
      `\n\n问题：${q}\n\n回答：`;
    return { answer: (await callClaude(prompt, '基于图谱问答')).trim() };
  }));

  app.post('/api/reader/quiz_make', (req, res) => ccGuard(res, async () => {
    const pool = req.body.pool || [];
    const n = req.body.n || 5;
    if (!pool.length) return { questions: [] };
    const prompt =
      `你是一位出题老师。下面是读者在 AI 动态导读里**标注过的术语/笔记**（JSON 数组，每条有 id、kind、term、definition、quote、note）。` +
      `请从中挑选最多 ${n} 个，针对每个出**一道考察理解的简答题**：用中文、鼓励读者用自己的话回答、别死抠字面。` +
      '只输出 JSON：{ "questions": [ {"id": "原条目id", "question": "题干"} ] }\n\n素材：\n' +
      JSON.stringify(pool);
    const obj = extractJSON(await callClaude(prompt, '出题小测'));
    return { questions: Array.isArray(obj) ? obj : (obj.questions || obj) };
  }));

  app.post('/api/reader/quiz_grade', (req, res) => ccGuard(res, async () => {
    const items = req.body.items || [];
    if (!items.length) return { results: [] };
    const prompt =
      '你是一位批改老师。下面每题有：题目 question、参考材料 reference（标准定义/上下文）、读者答案 answer。' +
      '请逐题批改：verdict 取 {对, 部分对, 不对}；comment 给一句中文点评（指出对在哪/漏了什么）；correct 给一句简短参考答案。' +
      '只输出 JSON：{ "results": [ {"id":"", "verdict":"", "comment":"", "correct":""} ] }\n\n数据：\n' +
      JSON.stringify(items);
    const obj = extractJSON(await callClaude(prompt, '批改小测'));
    return { results: Array.isArray(obj) ? obj : (obj.results || obj) };
  }));

  app.post('/api/reader/extract', (req, res) => ccGuard(res, async () => {
    const date = req.body.date || '';
    const p = deckPath(date);
    if (!p) return { error: `no deck for ${date}` };
    const raw = fs.readFileSync(p, 'utf-8');
    const slides = parseDeck.slideTexts(raw);
    const existing = new Set(G.load('posts').map((x) => x.id));
    const stamp = 'p_' + date.replace(/-/g, '');
    if ([...existing].some((id) => id.startsWith(stamp))) return { status: 'already_extracted', date };
    const slideBlob = slides.map((s) => `[slide ${s.slide_index}]\n${s.text}`).join('\n\n');
    const prompt =
      `这是 ${date} 的「小钻风 / Hot from Kitchen」AI 动态导读，每屏一条 post。` +
      '请抽取结构化 JSON（只输出 JSON），schema:\n' +
      '{ "posts": [ { "id": "p_YYYYMMDD_NN(NN取自 index 左值)", "slide_index": N, "index_label":"NN / MM",' +
      ' "category":"如 Launch/Paper/Infra", "is_long_read": bool, "headline":"", ' +
      '"source": {"handle":"","domain":"","grounding":""}, "url":"", "body_summary":"1-3句客观摘要", ' +
      '"mentions": ["e_xxx 实体id(小写下划线)"] } ],\n' +
      ' "entities": [ {"id":"e_xxx","type":"company|person|product|paper|concept|benchmark|framework|tool|source|project",' +
      `"canonical_name":"","aliases":[],"description":"一句话","first_seen":"${date}","mentions":["p_..."]} ],\n` +
      ` "opinions": [ {"id":"o_<postid>_<holder>","holder":"yibo|claude","post_id":"p_...","label":"Yibo's take/Claude's read",` +
      `"stance":"supportive|skeptical|pushback|neutral|mixed|analytical","about":["e_..."],"text":"原话","date":"${date}"} ],\n` +
      ` "relations": [ {"id":"r_xxxx","src":"e_/p_","dst":"e_/p_","type":"made_by/replaces/benchmarked_on/competes_with/responds_to/same_thread_as/...","evidence":"p_...","date":"${date}","note":""} ] }\n` +
      '注意三种声音：source 进 posts.body_summary；Yibo\'s take 与 Claude\'s read 进 opinions。' +
      '实体 id 用小写下划线 slug。\n\n导读全文：\n' + slideBlob;
    const obj = extractJSON(await callClaude(prompt, '抽取入图谱'));
    return G.mergeGraph(obj);
  }));

  // Detect action-tasks hidden in the day's commentary (Yibo's take / Claude's read
  // / body) and persist them as kind="task" annotations so the reader highlights them.
  // slide_index is resolved server-side (find the slide whose text contains the quote)
  // so anchoring doesn't depend on CC getting the index right — and a paraphrased
  // (non-verbatim) quote that no slide contains is dropped.
  app.post('/api/reader/detect_tasks', (req, res) => ccGuard(res, async () => {
    const date = req.body.date || '';
    const p = deckPath(date);
    if (!p) return { error: `no deck for ${date}` };
    const raw = fs.readFileSync(p, 'utf-8');
    const slides = parseDeck.slideTexts(raw);
    const blob = slides.map((s) => `[slide ${s.slide_index}]\n${s.text}`).join('\n\n');
    const prompt =
      `这是 ${date} 的「小钻风」AI 动态导读。评论（Yibo's take / Claude's read / 正文）里有时会冒出**行动任务**——` +
      `读者(Yibo)可以去做的具体动作：该试某工具、该构建/研究某东西、待办、TODO、“应该…/可以…/试试…/得去…”。\n` +
      `请找出真实出现的任务，逐条给出**逐字原文引用**(quote，必须是导读里一字不差的连续片段，用于定位)和一句**中文任务描述**(task)。` +
      `只算真正可执行的动作，别把普通观点/评论当任务。没有就返回空数组。\n` +
      `只输出 JSON：{ "tasks": [ {"quote": "原文片段", "task": "一句话任务"} ] }\n\n导读全文：\n` + blob;
    const obj = extractJSON(await callClaude(prompt, '检测任务'));
    const tasks = Array.isArray(obj) ? obj : (obj.tasks || []);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const canon = (s) => norm(s).toLowerCase().replace(/[.,!?;:'"“”‘’]/g, '');   // fuzzy key: CC varies quote boundaries/punctuation run-to-run
    const findSlide = (q) => { const nq = norm(q); for (const s of slides) if (norm(s.text).includes(nq)) return s.slide_index; return -1; };
    const seen = G.load('annotations').filter((a) => a.date === date && a.kind === 'task')
      .map((a) => canon((a.anchor && a.anchor.quote) || '')).filter(Boolean);
    const isDupe = (cq) => seen.some((e) => e.includes(cq) || cq.includes(e));   // either-direction containment catches sub/super-span re-detections
    const newTasks = [];
    for (const t of tasks) {
      const quote = (t.quote || '').trim();
      const cq = canon(quote);
      if (!cq || isDupe(cq)) continue;
      const si = findSlide(quote);
      if (si < 0) continue;                       // quote not verbatim in any slide → can't anchor, skip
      const anno = {
        id: 'a_task_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        created_at: new Date().toISOString(), date,
        post_id: null, slide_index: si,
        anchor: { quote, prefix: '', suffix: '', slide_index: si },
        kind: 'task', payload: (t.task || '').trim(), answer: '', auto: true, linked_entities: [],
      };
      G.annotate({ annotation: anno });
      seen.push(cq);
      newTasks.push(anno);
    }
    return { status: 'ok', added: newTasks.length, total: tasks.length, newTasks };
  }));

  app.post('/api/reader/annotate', (req, res) => {
    try { res.json(G.annotate(req.body)); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Delete a graph entity (cascades to its relations + mention refs) or a relation.
  app.post('/api/reader/graph/delete', (req, res) => {
    try {
      if (req.body.entity) return res.json(G.deleteEntity(req.body.entity));
      if (req.body.relation) return res.json(G.deleteRelation(req.body.relation));
      res.status(400).json({ error: 'need entity or relation id' });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  console.log(`[Reader] 小钻风 mounted at /reader  (decks: ${listDecks().map((d) => d.date).join(', ') || 'none'})`);

  // Auto-enable local translation: if Ollama is installed, start `ollama serve`,
  // then pull the fast model in the background if it's missing — first-run setup
  // with zero clicks. If Ollama isn't installed, we silently stay on CC fallback.
  (async () => {
    try {
      const r = await tx.ensureServe();
      console.log(`[Reader] ollama serve: ${r.reason}`);
      if (r.up) {
        const s = await tx.status();
        if (!s.hasFast) { console.log(`[Reader] 后台下载本地翻译模型 ${s.fast}…`); tx.autoPullFast(); }
      }
    } catch (e) { console.log('[Reader] ollama auto-start skipped:', e.message || e); }
  })();
}

module.exports = { mountReader };
