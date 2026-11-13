// Dependency-free vector store: an exact cosine scan over vectors kept in memory and persisted as one JSON
// file through the Obsidian vault adapter, so it works on every platform without extra installs.
const encodeVector = v => Buffer.from(new Float32Array(v).buffer).toString("base64");
function decodeVector(text) {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

const FILES = new Map();

class LocalStore {
  constructor(settings, adapter, filePath) {
    this.settings = settings;
    this.adapter = adapter;
    this.filePath = filePath;
    this.collectionName = settings.collection;
    this.signatureValue = JSON.stringify([settings.embeddingProvider, settings.embeddingUrl, settings.embeddingModel]);
  }
  // One shared in-memory copy per file so short-lived store instances see each other's writes.
  async file() {
    let entry = FILES.get(this.filePath);
    if (!entry) {
      entry = { data: { collections: {} }, dirty: false, bytes: 0 };
      try {
        const raw = await this.adapter.read(this.filePath);
        const parsed = JSON.parse(raw);
        if (parsed && parsed.collections && typeof parsed.collections === "object") entry.data = parsed;
        entry.bytes = Buffer.byteLength(raw);
      } catch (_) { /* a missing or unreadable file means an empty index */ }
      FILES.set(this.filePath, entry);
    }
    return entry;
  }
  async collection(create = false) {
    const entry = await this.file();
    let c = entry.data.collections[this.collectionName];
    if (c && c.signature !== this.signatureValue) {
      throw new Error("Collection uses a different embedding provider, URL, model or vector dimension; choose a new collection.");
    }
    if (!c && create) c = entry.data.collections[this.collectionName] = { signature: this.signatureValue, dimensions: 0, chunks: {} };
    return { entry, c };
  }
  async list() {
    const { c } = await this.collection();
    return c ? Object.entries(c.chunks).map(([id, chunk]) => ({ id, path: chunk.path })) : [];
  }
  async upsert(chunks, vectors) {
    if (!chunks.length) return;
    if (chunks.length !== vectors.length) throw new Error("Chunk and vector counts do not match.");
    const dimensions = vectors[0].length;
    if (!dimensions || vectors.some(v => v.length !== dimensions || v.some(n => !Number.isFinite(n)))) {
      throw new Error("Embedding dimensions do not match.");
    }
    const { entry, c } = await this.collection(true);
    if (c.dimensions && c.dimensions !== dimensions) throw new Error("Collection uses a different embedding provider, URL, model or vector dimension; choose a new collection.");
    c.dimensions = dimensions;
    chunks.forEach((chunk, i) => { c.chunks[chunk.id] = { path: chunk.path, text: chunk.text, v: encodeVector(vectors[i]) }; });
    entry.dirty = true;
  }
  async delete(ids) {
    const { entry, c } = await this.collection();
    if (!c) return;
    for (const id of ids) if (id in c.chunks) { delete c.chunks[id]; entry.dirty = true; }
  }
  async search(vector, limit = 5) {
    const { c } = await this.collection();
    if (!c) return [];
    if (c.dimensions && c.dimensions !== vector.length) throw new Error("Collection uses a different embedding provider, URL, model or vector dimension; choose a new collection.");
    const norm = Math.sqrt(vector.reduce((s, n) => s + n * n, 0)) || 1;
    const scored = [];
    for (const [id, chunk] of Object.entries(c.chunks)) {
      const v = decodeVector(chunk.v);
      let dot = 0, sq = 0;
      for (let i = 0; i < v.length; i++) { dot += v[i] * vector[i]; sq += v[i] * v[i]; }
      scored.push({ id, path: chunk.path, text: chunk.text, score: dot / ((Math.sqrt(sq) || 1) * norm) });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, limit).map(({ path, text }) => ({ path, text }));
  }
  async flush() {
    const entry = await this.file();
    if (!entry.dirty) return;
    const raw = JSON.stringify(entry.data);
    await this.adapter.write(this.filePath, raw);
    entry.bytes = Buffer.byteLength(raw);
    entry.dirty = false;
  }
  async stats() {
    const { entry, c } = await this.collection();
    const chunks = c ? Object.values(c.chunks) : [];
    const result = {
      store: "Built-in local index", chunks: chunks.length, notes: new Set(chunks.map(x => x.path)).size,
      textBytes: chunks.reduce((s, x) => s + Buffer.byteLength(x.text), 0), fileBytes: entry.bytes, canReset: true, embedding: null
    };
    if (c && c.dimensions) {
      const [provider, url, model] = JSON.parse(c.signature);
      result.embedding = { provider, url, model, dimensions: c.dimensions, matches: true };
    }
    return result;
  }
  async reset() {
    const entry = await this.file();
    delete entry.data.collections[this.collectionName];
    entry.dirty = true;
    await this.flush();
  }
}

module.exports = { LocalStore };
