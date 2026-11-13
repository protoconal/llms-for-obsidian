const { endpoint, jsonRequest } = require("./models");

// Vector stores implement upsert, delete, list and search using chunks with path and text.
class ChromaStore {
  constructor(settings) {
    this.settings = settings;
    this.collectionId = null;
  }
  base() {
    const s = this.settings;
    return endpoint(s.chromaUrl, `/api/v2/tenants/${encodeURIComponent(s.chromaTenant)}/databases/${encodeURIComponent(s.chromaDatabase)}`);
  }
  async collection() {
    if (!this.collectionId) {
      const result = await jsonRequest(`${this.base()}/collections`, "POST",
        { name: this.settings.collection, get_or_create: true });
      if (!result.id) throw new Error("ChromaDB did not return a collection ID.");
      this.collectionId = result.id;
    }
    return `${this.base()}/collections/${encodeURIComponent(this.collectionId)}`;
  }
  async upsert(chunks, vectors) {
    if (!chunks.length) return;
    await jsonRequest(`${await this.collection()}/upsert`, "POST", {
      ids: chunks.map(c => c.id), documents: chunks.map(c => c.text),
      metadatas: chunks.map(c => ({ path: c.path })), embeddings: vectors
    });
  }
  async delete(ids) {
    if (ids.length) await jsonRequest(`${await this.collection()}/delete`, "POST", { ids });
  }
  async list() {
    const entries = [];
    const url = `${await this.collection()}/get`;
    for (let offset = 0;; offset += 1000) {
      const result = await jsonRequest(url, "POST", { include: ["metadatas"], limit: 1000, offset });
      if (!Array.isArray(result.ids) || !Array.isArray(result.metadatas) || result.ids.length !== result.metadatas.length) {
        throw new Error("ChromaDB returned invalid collection entries.");
      }
      result.ids.forEach((id, i) => entries.push({ id, path: result.metadatas[i] && result.metadatas[i].path }));
      if (result.ids.length < 1000) return entries;
    }
  }
  async stats() {
    const entries = await this.list();
    return { store: "ChromaDB", chunks: entries.length, notes: new Set(entries.map(e => e.path)).size, textBytes: null, fileBytes: null };
  }
  async search(vector, limit = 5) {
    const result = await jsonRequest(`${await this.collection()}/query`, "POST", {
      query_embeddings: [vector], n_results: limit, include: ["documents", "metadatas"]
    });
    const documents = result.documents && result.documents[0];
    const metadatas = result.metadatas && result.metadatas[0];
    if (!Array.isArray(documents) || !Array.isArray(metadatas) || documents.length !== metadatas.length) {
      throw new Error("ChromaDB returned invalid search results.");
    }
    return documents.map((text, i) => ({ text, path: metadatas[i] && metadatas[i].path }));
  }
}

module.exports = { ChromaStore };
