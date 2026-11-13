const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === "obsidian") return { Plugin: class {}, PluginSettingTab: class {}, ItemView: class {}, FuzzySuggestModal: class {}, Platform: { isDesktopApp: true } };
  return load.call(this, name, ...args);
};
const Plugin = require("../main.js");
Module._load = load;
const { SQLiteStore, KnowledgeBase, DEFAULTS } = Plugin.test;

test("SQLite vec persists, isolates collections, updates, searches and deletes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-sqlite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, "vectors.sqlite3");
  const s = { ...DEFAULTS, collection: "a ' \" ; DROP TABLE chunks; --" };
  const store = new SQLiteStore(s, db);
  assert.deepEqual(await store.list(), []);
  await store.upsert([
    { id: "a:0", path: "a.md", text: "target ' ; DROP TABLE chunks; --" },
    { id: "b:0", path: "b.md", text: "other" }
  ], [[1, 0], [0, 1]]);
  const reopened = new SQLiteStore(s, db);
  assert.deepEqual(await reopened.list(), [{ id: "a:0", path: "a.md" }, { id: "b:0", path: "b.md" }]);
  assert.deepEqual(await reopened.search([1, 0], 1), [{ path: "a.md", text: "target ' ; DROP TABLE chunks; --" }]);
  await reopened.upsert([{ id: "a:0", path: "new.md", text: "updated" }], [[0, 1]]);
  assert.deepEqual(await reopened.search([0, 1], 1), [{ path: "new.md", text: "updated" }]);
  const other = new SQLiteStore({ ...s, collection: "other" }, db);
  await other.upsert([{ id: "a:0", path: "independent.md", text: "independent" }], [[1, 0, 0]]);
  await reopened.delete(["a:0", "b:0"]);
  assert.deepEqual(await reopened.list(), []);
  assert.equal((await other.list()).length, 1);
  await assert.rejects(other.upsert([{ id: "x", path: "x", text: "x" }], [[1, 2]]), /Collection uses/);
  await assert.rejects(other.search([1, 2]), /Collection uses/);
  const changed = new SQLiteStore({ ...s, collection: "other", embeddingModel: "another" }, db);
  await assert.rejects(changed.list(), /Collection uses/);
  assert.equal((await other.list()).length, 1);
  await assert.rejects(other.search([0, 0, 0]), /non-zero/);
});

test("SQLite index reconciles notes and persists with a fresh store", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-sqlite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, "index.sqlite3");
  let notes = { "first.md": "one", "gone.md": "two" };
  const vault = { getMarkdownFiles: () => Object.keys(notes).map(path => ({ path })), cachedRead: async f => notes[f.path] };
  const model = { embed: async texts => texts.map(() => [1, 0]) };
  const kb = () => new KnowledgeBase(vault, model, new SQLiteStore(DEFAULTS, db));
  assert.equal(await kb().index(), 2);
  notes = { "first.md": "changed" };
  await kb().index();
  assert.deepEqual(await kb().search("question"), [{ path: "first.md", text: "changed" }]);
});

test("plugin selects SQLite only for desktop vaults and retains Chroma default", () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULTS, vectorStore: "sqlite" };
  plugin.manifest = { id: "llms-for-obsidian" };
  plugin.app = { vault: { configDir: ".obsidian", adapter: { getBasePath: () => "/vault" } } };
  assert.ok(plugin.knowledge().store instanceof SQLiteStore);
  assert.equal(plugin.knowledge().store.databasePath, path.join("/vault", ".obsidian", "plugins", "llms-for-obsidian", "vectors.sqlite3"));
  plugin.app.vault.adapter = {};
  assert.throws(() => plugin.knowledge(), /desktop vault/);
  plugin.settings.vectorStore = "chroma";
  assert.equal(plugin.knowledge().store.constructor.name, "ChromaStore");
});
