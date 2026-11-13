function sqlText(value) {
  return "CAST(X'" + Buffer.from(value, "utf8").toString("hex") + "' AS TEXT)";
}

function vectorJSON(vector) {
  if (!Array.isArray(vector) || !vector.length ||
      vector.some(n => !Number.isFinite(n) || Math.abs(n) > 3.402823466e38) ||
      !vector.some(n => Math.abs(n) >= 1.401298464e-45)) {
    throw new Error("SQLite vectors must contain finite, non-zero float32 values.");
  }
  return JSON.stringify(vector);
}

class SQLiteStore {
  constructor(settings, databasePath) {
    this.settings = settings;
    this.databasePath = databasePath;
    this.collection = sqlText(settings.collection);
    this.signatureValue = JSON.stringify([settings.embeddingProvider, settings.embeddingUrl, settings.embeddingModel]);
    this.signature = sqlText(this.signatureValue);
  }
  // Prefer a sqlite3 binary shipped in <plugin>/bin, falling back to PATH.
  cliPath() {
    const path = require("node:path"), fs = require("node:fs");
    const bundled = path.join(path.dirname(this.databasePath), "bin", process.platform === "win32" ? "sqlite3.exe" : "sqlite3");
    return fs.existsSync(bundled) ? bundled : "sqlite3";
  }
  async execute(sql, guard = true) {
    const { spawn } = require("node:child_process");
    let extension;
    try { extension = require("sqlite-vec").getLoadablePath(); }
    catch (error) { throw new Error(`sqlite-vec extension unavailable: ${error.message}. See setup instructions.`); }
    if (/[\r\n]/.test(extension)) throw new Error("Invalid sqlite-vec installation path.");
    const quoted = extension.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const schema = `
      CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, signature TEXT NOT NULL, dimensions INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (collection TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, PRIMARY KEY(collection, id));
    ` + (guard ? `
      CREATE TEMP TABLE collection_guard (ok INTEGER CHECK(ok=1));
      INSERT INTO collection_guard SELECT CASE WHEN signature=${this.signature} THEN 1 ELSE 0 END FROM collections WHERE name=${this.collection};
    ` : "");
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath(), ["-batch", "-bail", "-json", "-cmd", ".timeout 5000", "-cmd", `.load "${quoted}"`, this.databasePath], { windowsHide: true });
      let output = "", errors = "", failed = false;
      const fail = error => { if (!failed) { failed = true; reject(error); } };
      child.on("error", error => fail(new Error(`Unable to start SQLite CLI: ${error.message}. See setup instructions.`)));
      child.stdin.on("error", error => { if (error.code !== "EPIPE") fail(error); });
      child.stdout.on("data", data => {
        output += data;
        if (output.length > 64 * 1024 * 1024) { child.kill(); fail(new Error("SQLite output exceeds 64 MiB.")); }
      });
      child.stderr.on("data", data => { if (errors.length < 8192) errors += data.toString().slice(0, 8192 - errors.length); });
      child.on("close", code => {
        if (failed) return;
        if (code !== 0) {
          const message = errors.includes("CHECK constraint failed: ok=1") ? "Collection uses a different embedding provider, URL, model or vector dimension; choose a new collection." : errors.trim();
          fail(new Error(`SQLite operation failed: ${message || `exit ${code}`}`));
          return;
        }
        try { resolve(output.trim() ? JSON.parse(output) : []); }
        catch (_) { fail(new Error("SQLite returned invalid JSON.")); }
      });
      child.stdin.end(schema + sql);
    });
  }
  async list() {
    return this.execute(`SELECT id, path FROM chunks WHERE collection=${this.collection};`);
  }
  async stats() {
    const fs = require("node:fs/promises");
    let fileBytes = 0;
    for (const suffix of ["", "-wal", "-journal"]) {
      try { fileBytes += (await fs.stat(this.databasePath + suffix)).size; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const [row] = await this.execute(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT path) AS notes, COALESCE(SUM(LENGTH(CAST(text AS BLOB))),0) AS textBytes FROM chunks WHERE collection=${this.collection};`, false);
    const [meta] = await this.execute(`SELECT signature, dimensions FROM collections WHERE name=${this.collection};`, false);
    const result = { store: "SQLite + sqlite-vec", chunks: row.chunks, notes: row.notes, textBytes: row.textBytes, fileBytes, canReset: true, embedding: null };
    if (meta) {
      const [provider, url, model] = JSON.parse(meta.signature);
      const current = JSON.parse(this.signatureValue);
      result.embedding = { provider, url, model, dimensions: meta.dimensions,
        matches: provider === current[0] && url === current[1] && model === current[2] };
    }
    return result;
  }
  // Clears this collection, including its recorded embedding signature, without the signature guard.
  async reset() {
    await this.execute(`BEGIN IMMEDIATE; DELETE FROM chunks WHERE collection=${this.collection}; DELETE FROM collections WHERE name=${this.collection}; COMMIT;`, false);
  }
  async upsert(chunks, vectors) {
    if (!chunks.length) return;
    if (chunks.length !== vectors.length) throw new Error("Chunk and vector counts do not match.");
    const encoded = vectors.map(vectorJSON);
    const dimensions = vectors[0].length;
    if (vectors.some(v => v.length !== dimensions)) throw new Error("Embedding dimensions do not match.");
    const rows = chunks.map((c, i) => `(${this.collection},${sqlText(c.id)},${sqlText(c.path)},${sqlText(c.text)},${sqlText(encoded[i])})`).join(",");
    await this.execute(`
      BEGIN IMMEDIATE;
      INSERT INTO collections(name,signature,dimensions) VALUES(${this.collection},${this.signature},${dimensions}) ON CONFLICT(name) DO NOTHING;
      INSERT INTO collection_guard SELECT CASE WHEN signature=${this.signature} AND dimensions=${dimensions} THEN 1 ELSE 0 END FROM collections WHERE name=${this.collection};
      INSERT INTO chunks(collection,id,path,text,embedding) VALUES ${rows}
        ON CONFLICT(collection,id) DO UPDATE SET path=excluded.path,text=excluded.text,embedding=excluded.embedding;
      COMMIT;
    `);
  }
  async delete(ids) {
    if (!ids.length) return;
    await this.execute(`BEGIN IMMEDIATE; DELETE FROM chunks WHERE collection=${this.collection} AND id IN (${ids.map(sqlText).join(",")}); COMMIT;`);
  }
  async search(vector, limit = 5) {
    const encoded = sqlText(vectorJSON(vector));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid search limit.");
    return this.execute(`
      INSERT INTO collection_guard SELECT CASE WHEN dimensions=${vector.length} THEN 1 ELSE 0 END FROM collections WHERE name=${this.collection};
      SELECT path,text FROM chunks WHERE collection=${this.collection}
      ORDER BY vec_distance_cosine(embedding, ${encoded}) ASC, id ASC LIMIT ${limit};
    `);
  }
}

module.exports = { SQLiteStore };
