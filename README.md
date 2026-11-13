# LLMs for Obsidian

A local-first Obsidian plugin for chat, retrieval-augmented search, and generating wiki pages from notes. It runs models and the vector database as separate services; it does not download or run models inside Obsidian.

## Architecture

The plugin reads Markdown notes from the current vault, splits them into 1,500-character chunks, embeds them, and stores vectors, text and paths in a vector store. Queries are embedded using the same model and the nearest chunks are supplied to the chat model as reference material. The chat panel keeps an in-memory conversation. Wiki generation uses the active note and retrieved chunks to create a new Markdown file, without overwriting existing notes.

`KnowledgeBase` depends on a small store contract: `list()`, `upsert(chunks, vectors)`, `delete(ids)` and `search(vector, limit)`; `ChromaStore` implements it using the ChromaDB v2 HTTP API. Another backend can implement that contract and be wired into `knowledge()`. `ModelClient` supports Ollama and OpenAI-compatible chat and embedding APIs independently, so local embeddings can be used with a hosted chat model.

Indexing is explicit, not automatic: rerun it after edits, renames or deletions. It upserts current chunks and removes stale chunks for indexed paths and deleted notes. Use a **dedicated collection per vault and embedding model**: indexing removes entries for paths absent from the current vault. Switching embedding models requires a new collection and reindexing. Large vaults and long notes may exceed model or server limits; use an embedding model with an adequate context window.

## Setup

1. Install and start [Ollama](https://ollama.com/) and pull a chat model and an embedding model, for example `ollama pull llama3.2` and `ollama pull nomic-embed-text`.
2. Start a [ChromaDB](https://docs.trychroma.com/) server with its v2 API, for example `chroma run --host 127.0.0.1 --port 8000`. The default tenant and database must exist.
3. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/llms-for-obsidian/`, then enable **LLMs for Obsidian** in Obsidian's Community plugins settings. No build step or npm dependencies are required.
4. In plugin settings, verify model names, endpoints and the collection name. Run **Index vault for retrieval** from the command palette.
5. Open **LLM Chat** from the ribbon or command palette. Use **Generate wiki page from active note** to create a wiki page next to the active note.

Defaults connect to Ollama at `http://127.0.0.1:11434` and ChromaDB at `http://127.0.0.1:8000`. Both services must be reachable from the device running Obsidian. For other endpoints, select OpenAI-compatible and provide a base URL including `/v1`, model name, and optional bearer token. The **Use OpenRouter** button configures its chat URL and provider; supply an OpenRouter model and API key. Embeddings remain independently configurable. Disable retrieval in settings to chat without ChromaDB.

## Conversation compaction and model guidance

The chat panel automatically summarizes older turns before sending a message when it has at least ten messages, retaining the four most recent messages verbatim. **Compact conversation** runs this manually when more than four messages exist. The existing summary is incorporated on subsequent compactions and sent with future questions; both summary and history remain in memory until the panel is closed or cleared. If summarization fails, the original history is preserved and the unsent question is restored. Summaries are lossy and may omit or misrepresent information; long individual turns or summaries can still exceed the model's context limit. Compaction sends the older conversation to the configured chat endpoint.

The panel provides local, keyword-based model-type guidance as you type: embedding, coding, reasoning, vision or general-purpose. This is a heuristic, not a model benchmark or an autonomous model selector. It does not inspect installed models, change settings, send the draft anywhere, or guarantee a best choice; the configured chat model is still used. Image input is not currently supported.

## Lightweight storage alternatives

ChromaDB is currently the only implemented vector backend; it must be installed and started separately, and the plugin does not install software automatically. For a smaller deployment, **SQLite** with an extension such as [sqlite-vec](https://github.com/asg017/sqlite-vec) is an embedded alternative that can support vector similarity search; plain SQLite/FTS is keyword search, not a replacement for vector search. Integrating it would require an adapter for the store contract, a compatible SQLite runtime and vector extension on each supported Obsidian platform, plus an upgrade and backup strategy. A local file containing vectors with a brute-force cosine search is another dependency-free option for small vaults, at the cost of memory and linear search time. Neither alternative is implemented here.

Conversation compaction does not compact ChromaDB's physical storage. Reindexing already removes stale indexed chunks logically, but is not a database vacuum. Back up the database and consult the documentation for your installed ChromaDB version before undertaking any physical maintenance; the plugin does not run database maintenance commands.

## Privacy and limitations

With defaults, note contents stay on the local services. Changing an endpoint to a remote service sends the relevant data to that service: indexing sends all Markdown chunks to the embedding and vector endpoints; retrieval sends the question to the embedding endpoint; chat sends the question, conversation history and retrieved excerpts to the chat endpoint; wiki generation sends the active note and excerpts to the chat endpoint. API keys are stored **unencrypted** in Obsidian's plugin data. ChromaDB itself stores note text and vectors; secure its network access separately. Only configure endpoints you trust.

Retrieved notes are untrusted input and may contain misleading instructions. The plugin tells the model to treat them as data, but cannot guarantee prompt-injection resistance or factual answers. Review generated content and citations before relying on them. Retrieval and wiki generation require an available, indexed collection; errors are shown rather than silently switching providers.

## Development and verification

Run `npm test` with Node.js 18 or newer. Tests mock Obsidian and HTTP services; they do not replace a smoke test in Obsidian with running Ollama and ChromaDB. For a manual check, index a small vault, ask a question about a note in the chat panel, and generate a wiki page from that note. Inspect the response and new page, then rename or delete a note, reindex, and verify old results are gone.