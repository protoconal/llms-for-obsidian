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
  async index() {
    const files = this.vault.getMarkdownFiles().filter(file => !isArchivePath(file.path));
    const existing = await this.store.list();
    const archives = existing.filter(e => isArchivePath(e.path)).map(e => e.id);
    if (archives.length) await this.store.delete(archives);
    const paths = new Set(files.map(f => f.path));
    for (const file of files) {
      const chunks = chunkNote(file.path, await this.vault.cachedRead(file));
      const vectors = chunks.length ? await this.models.embed(chunks.map(c => c.text)) : [];
      await this.store.upsert(chunks, vectors);
      const newIds = new Set(chunks.map(c => c.id));
      await this.store.delete(existing.filter(e => e.path === file.path && !newIds.has(e.id)).map(e => e.id));
    }
    await this.store.delete(existing.filter(e => typeof e.path === "string" && !isArchivePath(e.path) && !paths.has(e.path)).map(e => e.id));
    return files.length;
  }
  async search(query) {
    const [vector] = await this.models.embed([query]);
    return (await this.store.search(vector)).filter(result => !isArchivePath(result.path));
  }
}

module.exports = { KnowledgeBase, chunkNote };
