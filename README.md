# LLMs for Obsidian

A local-first Obsidian plugin for chat, retrieval-augmented search, and generating wiki pages from notes. It does not download or run models inside Obsidian. Vector storage can use a separate ChromaDB service or a local SQLite database on desktop.

## Architecture

The plugin reads Markdown notes from the current vault, splits them into 1,500-character chunks, embeds them, and stores vectors, text and paths in a vector store. Queries are embedded using the same model and the nearest chunks are supplied to the chat model as reference material. The chat panel keeps an in-memory conversation. Wiki generation uses the active note and retrieved chunks to create a new Markdown file, without overwriting existing notes.

`KnowledgeBase` depends on a small store contract: `list()`, `upsert(chunks, vectors)`, `delete(ids)` and `search(vector, limit)`. `ChromaStore` implements it using the ChromaDB v2 HTTP API; `SQLiteStore` uses SQLite and sqlite-vec's cosine distance function. SQLite performs an exact linear scan, so search cost grows with collection size. Results can differ from ChromaDB's distance metric. `ModelClient` supports Ollama and OpenAI-compatible chat and embedding APIs independently, so local embeddings can be used with a hosted chat model.

Indexing is explicit, not automatic: rerun it after edits, renames or deletions. It upserts current chunks and removes stale chunks for indexed paths and deleted notes. Use a **dedicated collection per vault and embedding model**: indexing removes entries for paths absent from the current vault. Switching embedding models requires a new collection and reindexing. Large vaults and long notes may exceed model or server limits; use an embedding model with an adequate context window.

## Setup

1. Install and start [Ollama](https://ollama.com/) and pull a chat model and an embedding model, for example `ollama pull llama3.2` and `ollama pull nomic-embed-text`.
2. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/llms-for-obsidian/`, then enable **LLMs for Obsidian** in Obsidian's Community plugins settings.
3. Choose a vector store in plugin settings. For the default ChromaDB, start a [ChromaDB](https://docs.trychroma.com/) v2 server, for example `chroma run --host 127.0.0.1 --port 8000`. The default tenant and database must exist. For SQLite, follow the desktop setup below.
4. Verify model names, endpoints and the collection name. Run **Index vault for retrieval** from the command palette. Switching stores does not migrate data; index again.
5. Open **LLM Chat** from the ribbon or command palette. Use **Generate wiki page from active note** to create a wiki page next to the active note.

Defaults connect to Ollama at `http://127.0.0.1:11434` and ChromaDB at `http://127.0.0.1:8000`. Both services must be reachable from the device running Obsidian. For other endpoints, select OpenAI-compatible and provide a base URL including `/v1`, model name, and optional bearer token. The **Use OpenRouter** button configures its chat URL and provider; supply an OpenRouter model and API key. Embeddings remain independently configurable. Disable retrieval in settings to chat without a vector store.

## Conversation compaction and model guidance

The chat panel automatically summarizes older turns before sending a message when it has at least ten messages, retaining the four most recent messages verbatim. **Compact conversation** runs this manually when more than four messages exist. The existing summary is incorporated on subsequent compactions and sent with future questions; both summary and history remain in memory until the panel is closed or cleared. If summarization fails, the original history is preserved and the unsent question is restored. Summaries are lossy and may omit or misrepresent information; long individual turns or summaries can still exceed the model's context limit. Compaction sends the older conversation to the configured chat endpoint.

The panel provides local, keyword-based model-type guidance as you type: embedding, coding, reasoning, vision or general-purpose. This is a heuristic, not a model benchmark or an autonomous model selector. It does not inspect installed models, change settings, send the draft anywhere, or guarantee a best choice; the configured chat model is still used. Image input is not currently supported.

## SQLite + sqlite-vec desktop setup

SQLite uses the SQLite command-line executable and the official [sqlite-vec 0.1.9](https://github.com/asg017/sqlite-vec/tree/v0.1.9) npm distribution, whose platform packages contain upstream precompiled extension binaries. The exact npm versions and integrity hashes are pinned in `package-lock.json`; sqlite-vec is pre-1.0, so upgrades require compatibility testing. npm validates downloaded packages against the lockfile. No arbitrary extension path or automatic runtime download is used.

1. Install a trusted `sqlite3` CLI with JSON output and loadable extension support (SQLite 3.33 or later), available on the PATH inherited by Obsidian. On macOS the system SQLite may disable extension loading; install an extension-enabled build if needed. On Windows, install a matching-architecture SQLite CLI and ensure it is on Obsidian's PATH. Restart Obsidian after changing PATH.
2. On the target desktop, copy this repository's `package.json` and `package-lock.json` into `<vault>/.obsidian/plugins/llms-for-obsidian/` alongside `main.js` and `manifest.json`. From that directory run `npm ci --omit=dev` to install the pinned packages. The plugin does not install dependencies itself. Keep `node_modules/sqlite-vec` and the matching `node_modules/sqlite-vec-<platform>-<arch>` folder with the plugin when copying it.
3. Select **SQLite + sqlite-vec** as the vector store and index the vault. The official npm distribution supports Linux and macOS x64/arm64 and Windows x64; Windows arm64 and Obsidian mobile are not supported by this backend. ChromaDB remains available on mobile. sqlite3 and the extension must have compatible OS, architecture and runtime libraries. If they cannot load, the plugin reports an error instead of falling back silently.

SQLite stores note text and embeddings unencrypted in `<vault>/.obsidian/plugins/llms-for-obsidian/vectors.sqlite3`. Back it up while Obsidian is closed; deleting the plugin folder removes the index. Use separate collection names per vault and embedding model. SQLite rejects attempts to reuse a collection with a different embedding provider, endpoint, model or vector dimension; create a new collection and reindex. The local database is not a migration of existing ChromaDB collections. There is no built-in database vacuum: after backing up and closing Obsidian, an administrator may use SQLite's `VACUUM` on the database.

Conversation compaction does not compact ChromaDB's physical storage. Reindexing already removes stale indexed chunks logically, but is not a database vacuum. Back up the database and consult the documentation for your installed ChromaDB version before undertaking any physical maintenance; the plugin does not run database maintenance commands.

## Privacy and limitations

With defaults, note contents stay on the local services. Changing an endpoint to a remote service sends the relevant data to that service: indexing sends all Markdown chunks to the embedding endpoint and, when selected, the ChromaDB endpoint; retrieval sends the question to the embedding endpoint; chat sends the question, conversation history and retrieved excerpts to the chat endpoint; wiki generation sends the active note and excerpts to the chat endpoint. API keys are stored **unencrypted** in Obsidian's plugin data. Both vector stores retain note text and vectors; secure their files and network access. Only configure endpoints you trust.

Retrieved notes are untrusted input and may contain misleading instructions. The plugin tells the model to treat them as data, but cannot guarantee prompt-injection resistance or factual answers. Review generated content and citations before relying on them. Retrieval and wiki generation require an available, indexed collection; errors are shown rather than silently switching providers.

## Development and verification

Run `npm ci` and `npm test` with Node.js 18 or newer and an extension-enabled `sqlite3` CLI on PATH. SQLite integration tests use the real database and sqlite-vec binary; Obsidian and HTTP services are mocked. These do not replace a smoke test in Obsidian with the selected storage backend and model services. For a manual check, index a small vault, ask a question about a note in the chat panel, and generate a wiki page from that note. Inspect the response and new page, then rename or delete a note, reindex, and verify old results are gone.