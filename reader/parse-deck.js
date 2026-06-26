// parse-deck.js — JS port of tools/parse_deck.py (slide_texts only).
// Template-agnostic: segments a daily "小钻风 / Hot from Kitchen" deck into
// slides and returns clean text per slide. This is what feeds the CC extractor
// (`claude -p`); it survives any markup scheme because it only relies on the
// `.slide` boundary, not on inner classes.

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&middot;': '·', '&times;': '×', '&rsquo;': '’',
  '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&copy;': '©',
};

function unescapeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z]+;/g, (m) => (m in ENTITIES ? ENTITIES[m] : m));
}

function clean(s) {
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);
  return s.replace(/\s+/g, ' ').trim();
}

function slideTexts(raw) {
  raw = raw.replace(/<style[\s\S]*?<\/style>/gi, '');
  raw = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  const out = [];
  for (const ch of raw.split(/(?=<section class="slide)/)) {
    if (!ch.includes('class="slide')) continue;
    const txt = clean(ch);
    if (txt.length > 30) out.push({ slide_index: out.length, text: txt });
  }
  return out;
}

module.exports = { slideTexts, clean };
