const { isArchivePath } = require("./archive");

function chunkNote(path, text) {
  const chunks = [];
  for (let start = 0; start < text.length; start += 1500) {
    const content = text.slice(start, start + 1500);
    if (content.trim()) chunks.push({ id: `${path}:${start}`, path, text: content });
  }
  return chunks;
}

class KnowledgeBase {
  constructor(vault, models, store) {
    this.vault = vault;
    this.models = models;
    this.store = store;
  }
  // With `state` ({ files: { path: [mtime, size] } }) only files whose TFile.stat changed are
  // re-embedded, unless `full`; a fingerprint is recorded only after that file is fully stored.
  async index({ state = null, full = false } = {}) {
    const files = this.vault.getMarkdownFiles().filter(file => !isArchivePath(file.path));
    const paths = new Set(files.map(f => f.path));
    const print = f => f.stat ? [f.stat.mtime, f.stat.size] : null;
    const known = state && !full ? state.files : {};
    const changed = files.filter(f => { const p = print(f), k = known[f.path]; return !(p && k && p[0] === k[0] && p[1] === k[1]); });
    const removed = state ? Object.keys(state.files).filter(p => !paths.has(p)) : [];
    this.changed = changed.length;
    if (state && !full && !changed.length && !removed.length) return files.length;
    const existing = await this.store.list();
    const archives = existing.filter(e => isArchivePath(e.path)).map(e => e.id);
    if (archives.length) await this.store.delete(archives);
    for (const file of changed) {
      const chunks = chunkNote(file.path, await this.vault.cachedRead(file));
      const vectors = chunks.length ? await this.models.embed(chunks.map(c => c.text)) : [];
      await this.store.upsert(chunks, vectors);
      const newIds = new Set(chunks.map(c => c.id));
      await this.store.delete(existing.filter(e => e.path === file.path && !newIds.has(e.id)).map(e => e.id));
      if (state) { const p = print(file); if (p) state.files[file.path] = p; else delete state.files[file.path]; }
    }
    await this.store.delete(existing.filter(e => typeof e.path === "string" && !isArchivePath(e.path) && !paths.has(e.path)).map(e => e.id));
    for (const path of removed) delete state.files[path];
    return files.length;
  }
  async search(query) {
    const [vector] = await this.models.embed([query]);
    return (await this.store.search(vector)).filter(result => !isArchivePath(result.path));
  }
}

module.exports = { KnowledgeBase, chunkNote };
