const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let requests = [];
let respond;
class Plugin {}
class PluginSettingTab {}
class ItemView {}
class Notice { constructor(message) { Notice.messages.push(message); } }
Notice.messages = [];
const obsidian = {
  Plugin, PluginSettingTab, ItemView, Notice, Setting: class {},
  requestUrl: async options => {
    requests.push(options);
    return respond(options);
  }
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "obsidian" ? obsidian : load.call(this, name, ...args);
};
const LLMPlugin = require("../main.js");
Module._load = load;
const { DEFAULTS, endpoint, ModelClient, ChromaStore, KnowledgeBase, chunkNote, recommendModel, compactConversation } = LLMPlugin.test;
const response = json => ({ status: 200, json });

test("validates endpoint URLs and builds model requests", async () => {
  assert.throws(() => endpoint("file:///etc/passwd", "/api"), /HTTP/);
  assert.throws(() => endpoint("https://" + "user" + "@" + "example.com", "/api"), /credentials/);
  requests = [];
  respond = () => response({ embeddings: [[0.1, 0.2]] });
  const models = new ModelClient({ ...DEFAULTS });
  assert.deepEqual(await models.embed(["hello"]), [[0.1, 0.2]]);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(JSON.parse(requests[0].body).input, ["hello"]);
  respond = () => response({ message: { content: "answer" } });
  assert.equal(await models.chat([{ role: "user", content: "hi" }]), "answer");
  assert.equal(JSON.parse(requests[1].body).stream, false);
});

test("OpenAI-compatible endpoints use bearer auth and ordered embeddings", async () => {
  requests = [];
  const models = new ModelClient({ ...DEFAULTS, chatProvider: "openai", chatUrl: "https://openrouter.ai/api/v1/",
    chatKey: "test-key", embeddingProvider: "openai", embeddingUrl: "https://example.com/v1" });
  respond = () => response({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] });
  assert.deepEqual(await models.embed(["one", "two"]), [[1], [2]]);
  respond = () => response({ choices: [{ message: { content: "ok" } }] });
  assert.equal(await models.chat([]), "ok");
  assert.equal(requests[1].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[1].headers.Authorization, "Bearer " + "test-key");
  respond = () => response({ data: [{ embedding: [null] }] });
  await assert.rejects(models.embed(["bad"]), /invalid vectors/);
  respond = () => ({ status: 401, json: {} });
  await assert.rejects(models.chat([]), /401/);
});

test("Chroma v2 adapter creates, lists, upserts, searches and deletes", async () => {
  requests = [];
  respond = options => {
    if (options.url.endsWith("/collections")) return response({ id: "collection-id" });
    if (options.url.endsWith("/get")) return response({ ids: ["a"], metadatas: [{ path: "a.md" }] });
    if (options.url.endsWith("/query")) return response({ documents: [["text"]], metadatas: [[{ path: "a.md" }]] });
    return response({});
  };
  const store = new ChromaStore({ ...DEFAULTS });
  assert.deepEqual(await store.list(), [{ id: "a", path: "a.md" }]);
  await store.upsert([{ id: "a", path: "a.md", text: "text" }], [[1]]);
  assert.deepEqual(await store.search([1]), [{ path: "a.md", text: "text" }]);
  await store.delete(["a"]);
  assert.equal(requests.filter(r => r.url.endsWith("/collections")).length, 1);
  assert.match(requests[0].url, /\/api\/v2\/tenants\/default_tenant\/databases\/default_database\/collections$/);
  assert.deepEqual(JSON.parse(requests[2].body).embeddings, [[1]]);
  assert.deepEqual(JSON.parse(requests[4].body).ids, ["a"]);
});

test("index updates chunks, removes stale and deleted notes, and searches", async () => {
  const entries = [{ id: "a.md:0", path: "a.md" }, { id: "a.md:1500", path: "a.md" },
    { id: "deleted.md:0", path: "deleted.md" }, { id: "foreign" }];
  const calls = [];
  const vault = { getMarkdownFiles: () => [{ path: "a.md" }, { path: "empty.md" }],
    cachedRead: async f => f.path === "a.md" ? "updated" : "" };
  const models = { embed: async texts => texts.map(() => [1, 2]) };
  const store = {
    list: async () => entries,
    upsert: async (chunks, vectors) => calls.push({ chunks, vectors }),
    delete: async ids => calls.push({ ids }),
    search: async vector => [{ text: String(vector), path: "a.md" }]
  };
  const kb = new KnowledgeBase(vault, models, store);
  assert.equal(await kb.index(), 2);
  assert.deepEqual(calls[0], { chunks: [{ id: "a.md:0", path: "a.md", text: "updated" }], vectors: [[1, 2]] });
  assert.deepEqual(calls.flatMap(c => c.ids || []), ["a.md:1500", "deleted.md:0"]);
  assert.deepEqual(await kb.search("question"), [{ text: "1,2", path: "a.md" }]);
  assert.equal(chunkNote("long.md", "x".repeat(1501)).length, 2);
});

test("failed embedding does not delete existing chunks", async () => {
  const deleted = [];
  const kb = new KnowledgeBase({ getMarkdownFiles: () => [{ path: "a.md" }], cachedRead: async () => "text" },
    { embed: async () => { throw new Error("offline"); } },
    { list: async () => [{ id: "a.md:0", path: "a.md" }], delete: async ids => deleted.push(ids) });
  await assert.rejects(kb.index(), /offline/);
  assert.deepEqual(deleted, []);
});

test("chat sends retrieved context and wiki never overwrites an existing page", async () => {
  requests = [];
  respond = options => {
    if (options.url.endsWith("/api/embed")) return response({ embeddings: [[1]] });
    if (options.url.endsWith("/collections")) return response({ id: "id" });
    if (options.url.endsWith("/query")) return response({ documents: [["reference"]], metadatas: [[{ path: "other.md" }]] });
    if (options.url.endsWith("/api/chat")) return response({ message: { content: "generated" } });
    throw new Error("Unexpected request");
  };
  const plugin = new LLMPlugin();
  plugin.settings = { ...DEFAULTS };
  let created;
  plugin.app = {
    vault: {
      cachedRead: async () => "source",
      getAbstractFileByPath: path => path === "note - Wiki.md",
      create: async (path, text) => (created = { path, text })
    },
    workspace: {
      getActiveFile: () => ({ path: "note.md", extension: "md" }),
      getLeaf: () => ({ openFile: async () => {} })
    }
  };
  assert.equal(await plugin.answer("question", []), "generated");
  const messages = JSON.parse(requests.find(r => r.url.endsWith("/api/chat")).body).messages;
  assert.match(messages[1].content, /other\.md\nreference/);
  await plugin.generateWiki();
  assert.deepEqual(created, { path: "note - Wiki 1.md", text: "generated" });
});

test("plugin bootstraps commands and panel can send and clear a message", async () => {
  class Element {
    constructor() { this.children = []; this.value = ""; }
    empty() { this.children = []; }
    setText(text) { this.text = text; }
    createEl(tag, options = {}) {
      const child = new Element();
      child.tag = tag;
      child.text = options.text;
      this.children.push(child);
      return child;
    }
    createDiv() { return this.createEl("div"); }
  }
  const plugin = new LLMPlugin();
  const commands = [];
  let factory;
  plugin.loadData = async () => ({ useRetrieval: false });
  plugin.registerView = (type, create) => { assert.equal(type, "llms-chat"); factory = create; };
  plugin.addSettingTab = () => {};
  plugin.addRibbonIcon = () => {};
  plugin.addCommand = command => commands.push(command.id);
  plugin.app = {};
  await plugin.onload();
  assert.deepEqual(commands, ["open-chat", "index-vault", "generate-wiki"]);
  const view = factory({});
  view.contentEl = new Element();
  respond = () => response({ message: { content: "hello" } });
  requests = [];
  await view.onOpen();
  const [, transcript, input, advice, send, , clear] = view.contentEl.children;
  input.value = "debug my code";
  input.oninput();
  assert.match(advice.text, /Code-oriented/);
  input.value = "hi";
  await send.onclick();
  assert.deepEqual(transcript.children.map(c => c.text), ["You: hi", "Assistant: hello"]);
  assert.equal(requests.length, 1);
  clear.onclick();
  assert.deepEqual(transcript.children, []);
  assert.deepEqual(view.history, []);
});

test("model guidance is local, task-specific and honest about unsupported image input", () => {
  assert.match(recommendModel("Generate an embedding"), /Embedding model/);
  assert.match(recommendModel("Debug my function"), /Code-oriented/);
  assert.match(recommendModel("Prove this math theorem"), /Reasoning-oriented/);
  assert.match(recommendModel("Describe this image"), /currently sends text only/);
  assert.match(recommendModel("Summarize my notes"), /General-purpose/);
});

test("compaction summarizes older turns and preserves recent turns and prior summary", async () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }));
  let prompt;
  const result = await compactConversation({ chat: async messages => { prompt = messages; return "new summary"; } }, "old summary", history);
  assert.equal(result.summary, "new summary");
  assert.deepEqual(result.history, history.slice(-4));
  assert.deepEqual(JSON.parse(prompt[1].content), { previousSummary: "old summary", messages: history.slice(0, -4) });
  assert.equal(history.length, 10);
  const short = await compactConversation({ chat: () => { throw Error("not called"); } }, "summary", history.slice(-4));
  assert.equal(short.summary, "summary");
});

test("automatic compaction keeps original conversation and input when summarization fails", async () => {
  class Element {
    constructor() { this.children = []; this.value = ""; }
    empty() { this.children = []; }
    setText(text) { this.text = text; }
    createEl(tag, options = {}) { const child = new Element(); child.text = options.text; this.children.push(child); return child; }
    createDiv() { return this.createEl("div"); }
  }
  const plugin = new LLMPlugin();
  let factory;
  plugin.loadData = async () => ({ useRetrieval: false });
  plugin.registerView = (_, create) => { factory = create; };
  plugin.addSettingTab = () => {};
  plugin.addRibbonIcon = () => {};
  plugin.addCommand = () => {};
  plugin.app = {};
  await plugin.onload();
  const view = factory({});
  view.contentEl = new Element();
  await view.onOpen();
  view.history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }));
  view.summary = "previous";
  respond = () => ({ status: 503, json: {} });
  const [, transcript, input, , send] = view.contentEl.children;
  input.value = "next question";
  await send.onclick();
  assert.equal(view.history.length, 10);
  assert.equal(view.summary, "previous");
  assert.equal(input.value, "next question");
  assert.match(transcript.children.at(-1).text, /503/);
  assert.equal(send.disabled, false);
});

test("chat automatically compacts and sends the summary on the next question", async () => {
  class Element {
    constructor() { this.children = []; this.value = ""; }
    empty() { this.children = []; }
    setText(text) { this.text = text; }
    createEl(tag, options = {}) { const child = new Element(); child.text = options.text; this.children.push(child); return child; }
    createDiv() { return this.createEl("div"); }
  }
  const plugin = new LLMPlugin();
  let factory;
  plugin.loadData = async () => ({ useRetrieval: false });
  plugin.registerView = (_, create) => { factory = create; };
  plugin.addSettingTab = () => {};
  plugin.addRibbonIcon = () => {};
  plugin.addCommand = () => {};
  plugin.app = {};
  await plugin.onload();
  const view = factory({});
  view.contentEl = new Element();
  await view.onOpen();
  view.history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }));
  requests = [];
  respond = () => response({ message: { content: requests.length === 1 ? "summary" : "answer" } });
  const [, , input, , send, , clear] = view.contentEl.children;
  input.value = "next";
  await send.onclick();
  assert.equal(requests.length, 2);
  assert.match(JSON.parse(requests[1].body).messages[1].content, /summary/);
  assert.equal(view.history.length, 6);
  assert.equal(view.summary, "summary");
  clear.onclick();
  assert.equal(view.summary, "");
  assert.deepEqual(view.history, []);
});

test("answer includes compacted summary alongside recent history", async () => {
  const plugin = new LLMPlugin();
  plugin.settings = { ...DEFAULTS, useRetrieval: false };
  requests = [];
  respond = () => response({ message: { content: "ok" } });
  await plugin.answer("next", [{ role: "user", content: "recent" }], "earlier summary");
  const messages = JSON.parse(requests[0].body).messages;
  assert.match(messages[1].content, /earlier summary/);
  assert.equal(messages[2].content, "recent");
  assert.equal(messages[3].content, "next");
});
