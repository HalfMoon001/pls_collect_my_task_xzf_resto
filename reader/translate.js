// translate.js — EN→ZH translation for the 小钻风 reader.
// Strategy (per product decision): prefer local Ollama (Qwen) when present; fall
// back to Claude CLI when Ollama isn't installed/running or a model is missing.
// Models are NOT bundled in the installer — the user opts in to downloading them.
//
//   mode "fast" -> Ollama qwen2.5:3b   (selection auto-translate, ~0.5s)
//   mode "fine" -> Ollama qwen2.5:7b   (精翻, ~1s)
//   mode "cc"   -> Claude CLI          (zero extra install; also the fallback)
//
// Ollama runs on localhost; Node's http module never uses a system proxy, so
// these calls go direct (the machine's 7897 proxy would otherwise break them).

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = +(process.env.OLLAMA_PORT || 11434);
const MODEL_FAST = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const MODEL_FINE = process.env.OLLAMA_MODEL_FINE || 'qwen2.5:7b';
const TX_MODELS = { fast: MODEL_FAST, fine: MODEL_FINE };

const TX_SYS =
  '你是专业的中英翻译引擎，专攻 AI 行业内容。把用户给的英文准确、地道地翻译成简体中文。' +
  '保留专有名词/产品名/人名原文（必要时括号补中文），术语符合 AI 圈惯例。' +
  '只输出译文，不要任何解释、不要前后缀、不要引号。';

function ollamaJSON(method, urlPath, payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const req = http.request(
      {
        host: OLLAMA_HOST, port: OLLAMA_PORT, path: urlPath, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad ollama response')); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ollama timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// --- managed Ollama lifecycle (per product decision: not bundled, auto-run if installed) ---
// We only ever stop the `ollama serve` WE started — an Ollama.app the user already
// runs is detected as up and left alone.
function findOllamaBin() {
  if (process.env.OLLAMA_BIN && fs.existsSync(process.env.OLLAMA_BIN)) return process.env.OLLAMA_BIN;
  const cands = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama', (process.env.HOME || '') + '/.local/bin/ollama'];
  for (const p of cands) if (p && fs.existsSync(p)) return p;
  return null;
}

let serveChild = null;     // the `ollama serve` process we spawned (null if we didn't)
let serveTried = false;

// Start `ollama serve` if Ollama is installed but not already running.
// Returns { up, started, reason } — never throws.
async function ensureServe() {
  if ((await status()).up) return { up: true, started: false, reason: 'already-running' };
  const bin = findOllamaBin();
  if (!bin) return { up: false, started: false, reason: 'not-installed' };
  if (serveTried) return { up: false, started: false, reason: 'starting' };
  serveTried = true;
  try {
    serveChild = spawn(bin, ['serve'], { stdio: 'ignore', env: { ...process.env } });
    serveChild.on('error', () => { serveChild = null; });
    serveChild.on('exit', () => { serveChild = null; });
  } catch (e) {
    return { up: false, started: false, reason: 'spawn-failed:' + (e.message || e) };
  }
  for (let i = 0; i < 12; i++) {                       // poll up to ~6s for the port to open
    await new Promise((r) => setTimeout(r, 500));
    if ((await status()).up) return { up: true, started: true, reason: 'started' };
  }
  return { up: false, started: true, reason: 'timeout' };
}

function stopServe() {
  if (serveChild) { try { serveChild.kill(); } catch {} serveChild = null; }
}
process.on('exit', stopServe);
process.on('SIGTERM', () => { stopServe(); process.exit(0); });
process.on('SIGINT', () => { stopServe(); process.exit(0); });

// --- background model pull (first-run, no clicks needed) ---
let pullState = { pulling: false, status: '', percent: 0, done: false, error: '' };
function pullState_() { return pullState; }

function autoPullFast() {
  if (pullState.pulling) return;
  pullState = { pulling: true, status: '准备下载…', percent: 0, done: false, error: '' };
  const data = Buffer.from(JSON.stringify({ name: MODEL_FAST, stream: true }));
  const req = http.request(
    { host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 0 },
    (r) => {
      let buf = '';
      r.on('data', (c) => {
        buf += c.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const o = JSON.parse(ln);
            if (o.status) pullState.status = o.status;
            if (o.total && o.completed) pullState.percent = Math.round((o.completed / o.total) * 100);
            if (o.error) pullState.error = o.error;
          } catch {}
        }
      });
      r.on('end', () => { pullState.pulling = false; pullState.done = !pullState.error; });
    }
  );
  req.on('error', (e) => { pullState = { pulling: false, status: '', percent: 0, done: false, error: String(e.message || e) }; });
  req.write(data); req.end();
}

// { up, models: [names], pull: {pulling,percent,...} }
async function status() {
  try {
    const r = await ollamaJSON('GET', '/api/tags', null, 4000);
    const models = (r.models || []).map((m) => m.name);
    return {
      up: true, models,
      hasFast: models.some((m) => m === MODEL_FAST || m.startsWith(MODEL_FAST)),
      hasFine: models.some((m) => m === MODEL_FINE || m.startsWith(MODEL_FINE)),
      fast: MODEL_FAST, fine: MODEL_FINE, pull: { ...pullState },
    };
  } catch {
    return { up: false, models: [], hasFast: false, hasFine: false, fast: MODEL_FAST, fine: MODEL_FINE, pull: { ...pullState } };
  }
}

async function localTranslate(text, model) {
  const r = await ollamaJSON('POST', '/api/chat', {
    model: model || MODEL_FAST, stream: false,
    messages: [{ role: 'system', content: TX_SYS }, { role: 'user', content: text }],
    options: { temperature: 0.2 },
  });
  return (r.message && r.message.content || '').trim().replace(/^"|"$/g, '').trim();
}

// Claude-CLI translation (fallback / mode=cc). callClaude is injected from server.
async function ccTranslate(text, callClaude) {
  const prompt =
    '你是翻译引擎。把下面的英文 AI 行业内容准确、地道地翻译成简体中文。' +
    '直接输出译文本身——禁止任何说明、译者注、前言、解释、关于工具的话。' +
    '保留专有名词/产品名/人名原文（可在括号补中文），术语符合 AI 圈惯例。\n\n---\n' + text;
  const out = (await callClaude(prompt, '翻译')).trim();
  const meta = ['译者注', '翻译任务', '无需调用', '以下是', '这是一个', '用户要求'];
  const parts = out.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !meta.some((k) => p.includes(k)));
  return (kept.join('\n\n') || out).trim();
}

// Stream `ollama pull <model>` progress as NDJSON to an http response.
function pullStream(model, res) {
  const data = Buffer.from(JSON.stringify({ name: model, stream: true }));
  const up = http.request(
    {
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 0,
    },
    (r) => { r.pipe(res); }
  );
  up.on('error', (e) => {
    try { res.write(JSON.stringify({ error: 'Ollama 未运行：' + e.message }) + '\n'); } catch {}
    res.end();
  });
  up.write(data);
  up.end();
}

module.exports = { status, localTranslate, ccTranslate, pullStream, ensureServe, autoPullFast, pullState: pullState_, TX_MODELS, MODEL_FAST, MODEL_FINE };
