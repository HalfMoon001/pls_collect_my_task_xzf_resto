// graph-store.js — read / merge the 小钻风 knowledge graph (JS port of the graph
// helpers in server.py). Graph lives as 5 JSON files under <dataDir>/reader/graph/.
// All ops are synchronous so a read-modify-write can't be interleaved (Node won't
// interrupt sync code); CC-driven writes are additionally serialized by the global
// CC lock in server.js.

const fs = require('fs');
const path = require('path');

const FILES = {
  posts: 'posts.json',
  entities: 'entities.json',
  relations: 'relations.json',
  opinions: 'opinions.json',
  annotations: 'annotations.json',
};

function slug(name) {
  const s = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return 'e_' + (s || 'x');
}

function makeGraphStore(graphDir, annoLogDir) {
  const file = (n) => path.join(graphDir, n);

  function load(key) {
    try {
      return JSON.parse(fs.readFileSync(file(FILES[key]), 'utf-8'))[key] || [];
    } catch {
      return [];
    }
  }

  function save(key, items) {
    fs.writeFileSync(file(FILES[key]), JSON.stringify({ schema_version: 1, [key]: items }, null, 2), 'utf-8');
  }

  function blob() {
    return {
      posts: load('posts'),
      entities: load('entities'),
      relations: load('relations'),
      opinions: load('opinions'),
      annotations: load('annotations'),
    };
  }

  // Idempotent merge of an extracted {posts,entities,opinions,relations} object.
  function mergeGraph(obj) {
    const added = { posts: 0, entities: 0, opinions: 0, relations: 0 };
    for (const key of ['posts', 'entities', 'opinions', 'relations']) {
      const cur = load(key);
      const ids = new Set(cur.map((x) => x.id));
      for (const item of obj[key] || []) {
        if (key === 'entities') {
          const cn = (item.canonical_name || '').toLowerCase();
          const match = cur.find((e) => (e.canonical_name || '').toLowerCase() === cn);
          if (match) {
            match.mentions = match.mentions || [];
            for (const m of item.mentions || []) if (!match.mentions.includes(m)) match.mentions.push(m);
            continue;
          }
        }
        if (item.id && ids.has(item.id)) continue;
        cur.push(item);
        if (item.id) ids.add(item.id);
        added[key] += 1;
      }
      save(key, cur);
    }
    return { status: 'merged', added };
  }

  // Upsert a term entity from a CC `define` result. Returns the entity row.
  function defineUpsert(obj, term, date, postId) {
    const ents = load('entities');
    const name = obj.term || term;
    const lname = name.toLowerCase();
    const lterm = (term || '').toLowerCase();
    let ent = ents.find((e) =>
      (e.canonical_name || '').toLowerCase() === lname ||
      (e.aliases || []).map((a) => a.toLowerCase()).includes(lterm) ||
      e.id === slug(name)
    );
    if (ent) {
      if (!ent.description) ent.description = obj.definition_zh || '';
      if (postId) { ent.mentions = ent.mentions || []; if (!ent.mentions.includes(postId)) ent.mentions.push(postId); }
    } else {
      ent = {
        id: slug(name),
        type: obj.type || 'concept',
        canonical_name: name,
        aliases: obj.aliases || [],
        description: obj.definition_zh || '',
        first_seen: date || '',
        mentions: postId ? [postId] : [],
        from_annotation: true,
      };
      ents.push(ent);
    }
    save('entities', ents);
    return ent;
  }

  // Save / replace / delete an annotation. Mirrors api_annotate.
  function annotate(body) {
    let annos = load('annotations');
    if (body.delete) {
      annos = annos.filter((a) => a.id !== body.delete);
      save('annotations', annos);
      return { status: 'deleted', id: body.delete };
    }
    const anno = body.annotation || body;
    annos = annos.filter((a) => a.id !== anno.id);
    annos.push(anno);
    save('annotations', annos);
    // append-only daily log
    try {
      const dir = path.join(annoLogDir, anno.date || 'undated');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, anno.id + '.json'), JSON.stringify(anno, null, 2), 'utf-8');
    } catch {}
    return { status: 'saved', id: anno.id };
  }

  // Delete a relation by id.
  function deleteRelation(id) {
    const rels = load('relations');
    const next = rels.filter((r) => r.id !== id);
    save('relations', next);
    return { status: 'deleted', id, removed: rels.length - next.length };
  }

  // Delete an entity and cascade: drop relations touching it, and scrub its id
  // from posts.mentions / opinions.about / annotations.linked_entities.
  function deleteEntity(id) {
    const ents = load('entities');
    const nextEnts = ents.filter((e) => e.id !== id);
    if (nextEnts.length === ents.length) return { status: 'not_found', id };
    save('entities', nextEnts);

    const rels = load('relations');
    const nextRels = rels.filter((r) => r.src !== id && r.dst !== id);
    save('relations', nextRels);

    const scrub = (key, field) => {
      const rows = load(key); let n = 0;
      for (const r of rows) if (Array.isArray(r[field]) && r[field].includes(id)) { r[field] = r[field].filter((x) => x !== id); n++; }
      if (n) save(key, rows);
      return n;
    };
    return {
      status: 'deleted', id,
      removed_relations: rels.length - nextRels.length,
      posts_scrubbed: scrub('posts', 'mentions'),
      opinions_scrubbed: scrub('opinions', 'about'),
      annotations_scrubbed: scrub('annotations', 'linked_entities'),
    };
  }

  return { load, save, blob, mergeGraph, defineUpsert, annotate, deleteEntity, deleteRelation, slug, graphDir };
}

module.exports = { makeGraphStore, slug };
