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
  const target = new URL(url);
  const context = `${method} ${target.origin}${target.pathname}${body && body.model ? ` (model: ${body.model})` : ""}`;
  const sensitive = [key, ...(body && Array.isArray(body.input) ? body.input : [body && body.input]),
    ...(body && Array.isArray(body.documents) ? body.documents : []),
    ...(body && Array.isArray(body.messages) ? body.messages.map(m => m.content) : [])]
    .filter(value => typeof value === "string" && value.length).sort((a, b) => b.length - a.length);
  const sanitize = value => {
    let text = String(value);
    for (const value of sensitive) {
      text = text.split(value).join("[redacted]");
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) text = text.split(escaped).join("[redacted]");
    }
    return text.replace(/\s+/g, " ").slice(0, 2000);
  };
  const fail = message => {
    const error = new Error(sanitize(message));
    console.error("[LLMs for Obsidian]", error.message);
    return error;
  };
  const headers = { "Content-Type": "application/json" };
  if (key) {
    const { protocol, hostname } = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    if (protocol !== "https:" && !loopback) throw new Error("Refusing to send an API key over plain HTTP to a non-local host. Use HTTPS.");
    headers.Authorization = "Bearer " + key;
  }
  let response;
  try {
    response = await requestUrl({
      url, method, headers, body: body === undefined ? undefined : JSON.stringify(body), throw: false
    });
  } catch (error) {
    throw fail(`Request could not complete: ${context}. ${error.message}`);
  }
  if (response.status < 200 || response.status >= 300) {
    let detail = response.text;
    if (!detail) {
      try { detail = JSON.stringify(response.json); }
      catch (_) { detail = "Response body was not valid JSON."; }
    }
    throw fail(`Request failed (HTTP ${response.status}): ${context}. ${detail || "No response body. Check endpoint and configuration."}`);
  }
  try { return response.json; }
  catch (_) {
    throw fail(`Invalid JSON response: ${context} (HTTP ${response.status}).`);
  }
}

class ModelClient {
  constructor(settings) { this.settings = settings; }

  async embed(texts, inputType = "document") {
    const s = this.settings;
    let vectors;
    if (s.embeddingProvider === "ollama") {
      const result = await jsonRequest(endpoint(s.embeddingUrl, "/api/embed"), "POST",
        { model: s.embeddingModel, input: texts }, s.embeddingKey);
      vectors = result.embeddings;
    } else {
      const result = await jsonRequest(endpoint(s.embeddingUrl, "/embeddings"), "POST",
        { model: s.embeddingModel, input: texts,
          ...(/^(?:perplexity\/)?pplx-embed-v2-/.test(s.embeddingModel) && { input_type: inputType }) }, s.embeddingKey);
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
