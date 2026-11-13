const { requestUrl } = require("obsidian");

function endpoint(base, path) {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  return base.slice(0, end) + path;
}

async function jsonRequest(url, method = "GET", body, key = "") {
  const headers = { "Content-Type": "application/json" };
  if (key) {
    const { protocol, hostname } = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    if (protocol !== "https:" && !loopback) throw new Error("Refusing to send an API key over plain HTTP to a non-local host. Use HTTPS.");
    headers.Authorization = "Bearer " + key;
  }
  const response = await requestUrl({
    url, method, headers, body: body === undefined ? undefined : JSON.stringify(body), throw: false
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request failed (${response.status}) at ${new URL(url).origin}. Check endpoint and configuration.`);
  }
  return response.json;
}

class ModelClient {
  constructor(settings) { this.settings = settings; }

  async embed(texts) {
    const s = this.settings;
    let vectors;
    if (s.embeddingProvider === "ollama") {
      const result = await jsonRequest(endpoint(s.embeddingUrl, "/api/embed"), "POST",
        { model: s.embeddingModel, input: texts }, s.embeddingKey);
      vectors = result.embeddings;
    } else {
      const result = await jsonRequest(endpoint(s.embeddingUrl, "/embeddings"), "POST",
        { model: s.embeddingModel, input: texts }, s.embeddingKey);
      vectors = Array.isArray(result.data) && result.data.slice().sort((a, b) => a.index - b.index).map(x => x.embedding);
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length ||
        vectors.some(v => !Array.isArray(v) || !v.length || v.some(n => !Number.isFinite(n)))) {
      throw new Error("Embedding endpoint returned invalid vectors.");
    }
    return vectors;
  }

  async chat(messages) {
    const s = this.settings;
    const maxTokens = Number.isSafeInteger(s.chatMaxTokens) && s.chatMaxTokens > 0 ? s.chatMaxTokens : 0;
    let content;
    if (s.chatProvider === "ollama") {
      const result = await jsonRequest(endpoint(s.chatUrl, "/api/chat"), "POST",
        { model: s.chatModel, messages, stream: false, ...(maxTokens && { options: { num_predict: maxTokens } }) }, s.chatKey);
      content = result.message && result.message.content;
    } else {
      const result = await jsonRequest(endpoint(s.chatUrl, "/chat/completions"), "POST",
        { model: s.chatModel, messages, stream: false, ...(maxTokens && { max_tokens: maxTokens }) }, s.chatKey);
      content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    }
    if (typeof content !== "string" || !content.trim()) throw new Error("Chat endpoint returned no text.");
    return content;
  }
}

module.exports = { endpoint, jsonRequest, ModelClient };
