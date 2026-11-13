// Live OpenRouter checks. Skipped without OPENROUTER_API_KEY (repo secret `openrouter_sk` in CI).
// The key has a $2.5/month budget, so every call uses a cheap model and a tiny token cap.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const key = process.env.OPENROUTER_API_KEY;
const obsidian = {
  Plugin: class {}, PluginSettingTab: class {}, ItemView: class {}, FuzzySuggestModal: class {}, Notice: class {}, Setting: class {},
  requestUrl: async ({ url, method, headers, body }) => {
    const response = await fetch(url, { method, headers, body });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  }
};
const load = Module._load;
Module._load = function (name, ...args) { return name === "obsidian" ? obsidian : load.call(this, name, ...args); };
const { test: api } = require("../main.js");
Module._load = load;
const { DEFAULTS, ModelClient } = api;

const settings = {
  ...DEFAULTS,
  chatProvider: "openai", chatUrl: "https://openrouter.ai/api/v1", chatKey: key,
  chatModel: process.env.OPENROUTER_CHAT_MODEL || "openai/gpt-4o-mini", chatMaxTokens: 16,
  embeddingProvider: "openai", embeddingUrl: "https://openrouter.ai/api/v1", embeddingKey: key,
  embeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL || "openai/text-embedding-3-small"
};

test("OpenRouter chat returns text within the token cap", { skip: !key && "OPENROUTER_API_KEY not set" }, async () => {
  const reply = await new ModelClient(settings).chat([{ role: "user", content: "Reply with the single word: pong" }]);
  assert.match(reply, /pong/i);
});

test("OpenRouter embeddings return one finite vector per input", { skip: !key && "OPENROUTER_API_KEY not set" }, async () => {
  const vectors = await new ModelClient(settings).embed(["obsidian note", "vector search"]);
  assert.equal(vectors.length, 2);
  assert.ok(vectors[0].length > 100);
  assert.equal(vectors[0].length, vectors[1].length);
});
