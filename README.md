# LLMs for Obsidian

A local-first Obsidian plugin for chat, retrieval-augmented search, and generating wiki pages from notes. It does not download or run models inside Obsidian. Vector storage can use a separate ChromaDB service or a local SQLite database on desktop.

## Architecture

The plugin reads Markdown notes from the current vault, splits them into 1,500-character chunks, embeds them, and stores vectors, text and paths in a vector store. Queries are embedded using the same model and the nearest chunks are supplied to the chat model as reference material. The chat panel archives conversations locally in the vault. Wiki generation uses the active note and retrieved chunks to create a new Markdown file, without overwriting existing notes.

`KnowledgeBase` depends on a small store contract: `list()`, `upsert(chunks, vectors)`, `delete(ids)` and `search(vector, limit)`. `ChromaStore` implements it using the ChromaDB v2 HTTP API; `SQLiteStore` uses SQLite and sqlite-vec's cosine distance function. SQLite performs an exact linear scan, so search cost grows with collection size. Results can differ from ChromaDB's distance metric. `ModelClient` supports Ollama and OpenAI-compatible chat and embedding APIs independently, so local embeddings can be used with a hosted chat model.

Indexing is explicit until you run it once; afterwards it can be scheduled (see below). It upserts current chunks and removes stale chunks for indexed paths and deleted notes. Use a **dedicated collection per vault and embedding model**: indexing removes entries for paths absent from the current vault. Switching embedding models requires a new collection and reindexing. Large vaults and long notes may exceed model or server limits; use an embedding model with an adequate context window.

For future efficient hourly indexing, Obsidian already exposes [`TFile.stat`](https://docs.obsidian.md/Reference/TypeScript+API/TFile) with [`mtime` and `size`](https://docs.obsidian.md/Reference/TypeScript+API/FileStats). Persist these per path and per vault, store, collection, embedding provider/model and chunking version; only read and re-embed changed files, reconcile deletes and renames, and record a new fingerprint only after a successful upsert and cleanup. An hourly registered timer could trigger the same serialized index operation. Timestamps and size are cheap but can miss edits that preserve both values; an optional content checksum or periodic full rebuild would catch those cases at extra I/O cost. This is now implemented; see Incremental and scheduled indexing.

## Setup

1. Install and start [Ollama](https://ollama.com/) and pull a chat model and an embedding model, for example `ollama pull llama3.2` and `ollama pull nomic-embed-text`.
2. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/llms-for-obsidian/`, then enable **LLMs for Obsidian** in Obsidian's Community plugins settings.
3. Choose a vector store in plugin settings. For the default ChromaDB, start a [ChromaDB](https://docs.trychroma.com/) v2 server, for example `chroma run --host 127.0.0.1 --port 8000`. The default tenant and database must exist. For SQLite, follow the desktop setup below.
4. Verify model names, endpoints and the collection name. Run **Index vault for retrieval** from the command palette. Switching stores does not migrate data; index again.
5. Open **LLM Chat** from the ribbon or command palette. Use **Generate wiki page from active note** to create a wiki page next to the active note.

Defaults connect to Ollama at `http://127.0.0.1:11434` and ChromaDB at `http://127.0.0.1:8000`. Both services must be reachable from the device running Obsidian. For other endpoints, select OpenAI-compatible and provide a base URL including `/v1`, model name, and optional bearer token. The **Use OpenRouter** button configures its chat URL and provider; supply an OpenRouter model and API key. Embeddings remain independently configurable. Disable retrieval in settings to chat without a vector store.

## Chat, search and archives

The chat panel's context selector chooses **Vault embeddings**, **Full active note**, or **No vault context** for each request. The default comes from the retrieval setting. Full active note sends the entire currently active Markdown note to the chat endpoint, without an embedding lookup; large notes may exceed the model's context limit. Archive-folder notes cannot be selected as active-note context.

Enter a literal phrase in the chat input and choose **Search vault text** to search the current Markdown contents locally, case-insensitively. Results include a short excerpt and can be clicked to open the note; the first 50 matching files are shown. This is a live linear scan, not ranked, tokenized or semantic search, and it does not require the embedding service or index. The input remains available for a subsequent chat message. Large vaults can take time to scan.

Successful chat turns are automatically saved as JSON in the vault's `LLM Chat Archives/` folder, including the full transcript and the compacted context needed to continue. **Restore archive** opens a picker; **Clear conversation** starts a new chat without deleting the archive. **Save archive** retries a failed save; if a file was changed externally, **Save new archive copy** avoids overwriting it. Failed writes are reported and clearing or restoring is blocked while changes are unsaved. A crash or closing the panel after a failed save can still lose unsaved turns. Failed/unsent messages are not archived.

The archive folder, including Markdown files and subfolders, is excluded from indexing and full-text search; existing indexed chunks under that folder are removed on the next indexing attempt and filtered from retrieval immediately. The JSON files are not Markdown. Keep archives in that folder: converting or moving them elsewhere as Markdown defeats path-based exclusion. Archives are **unencrypted**, may be synced or backed up with your vault, and can contain sensitive prompts and responses; protect or delete them accordingly. Do not edit archive JSON unless you understand its format; invalid files cannot be restored.

## Conversation compaction and model guidance

The chat panel automatically summarizes older turns before sending a message when it has at least ten messages, retaining the four most recent messages verbatim for model context. **Compact conversation** runs this manually when more than four messages exist. The existing summary is incorporated on subsequent compactions and sent with future questions; the archive retains the full transcript as well as the current summary and history. If summarization fails, the original history is preserved and the unsent question is restored. Summaries are lossy and may omit or misrepresent information; long individual turns or summaries can still exceed the model's context limit. Compaction sends the older conversation to the configured chat endpoint.

The panel provides local, keyword-based model-type guidance as you type: embedding, coding, reasoning, vision or general-purpose. This is a heuristic, not a model benchmark or an autonomous model selector. It does not inspect installed models, change settings, send the draft anywhere, or guarantee a best choice; the configured chat model is still used. Image input is not currently supported.

## SQLite + sqlite-vec desktop setup

SQLite uses the SQLite command-line executable and the official [sqlite-vec 0.1.9](https://github.com/asg017/sqlite-vec/tree/v0.1.9) npm distribution, whose platform packages contain upstream precompiled extension binaries. The exact npm versions and integrity hashes are pinned in `package-lock.json`; sqlite-vec is pre-1.0, so upgrades require compatibility testing. npm validates downloaded packages against the lockfile. No arbitrary extension path or automatic runtime download is used.

1. Install a trusted `sqlite3` CLI with JSON output and loadable extension support (SQLite 3.33 or later), available on the PATH inherited by Obsidian. On macOS the system SQLite may disable extension loading; install an extension-enabled build if needed. On Windows, install a matching-architecture SQLite CLI and ensure it is on Obsidian's PATH. Restart Obsidian after changing PATH.
2. On the target desktop, copy this repository's `package.json` and `package-lock.json` into `<vault>/.obsidian/plugins/llms-for-obsidian/` alongside `main.js` and `manifest.json`. From that directory run `npm ci --omit=dev` to install the pinned packages. The plugin does not install dependencies itself. Keep `node_modules/sqlite-vec` and the matching `node_modules/sqlite-vec-<platform>-<arch>` folder with the plugin when copying it.
3. Select **SQLite + sqlite-vec** as the vector store and index the vault. The official npm distribution supports Linux and macOS x64/arm64 and Windows x64; Windows arm64 and Obsidian mobile are not supported by this backend. ChromaDB remains available on mobile. sqlite3 and the extension must have compatible OS, architecture and runtime libraries. If they cannot load, the plugin reports an error instead of falling back silently.

SQLite stores note text and embeddings unencrypted in `<vault>/.obsidian/plugins/llms-for-obsidian/vectors.sqlite3`. Back it up while Obsidian is closed; deleting the plugin folder removes the index. Use separate collection names per vault and embedding model. SQLite rejects attempts to reuse a collection with a different embedding provider, endpoint, model or vector dimension; create a new collection and reindex. The local database is not a migration of existing ChromaDB collections. There is no built-in database vacuum: after backing up and closing Obsidian, an administrator may use SQLite's `VACUUM` on the database.

Conversation compaction does not compact ChromaDB's physical storage. Reindexing already removes stale indexed chunks logically, but is not a database vacuum. Back up the database and consult the documentation for your installed ChromaDB version before undertaking any physical maintenance; the plugin does not run database maintenance commands.

## Incremental and scheduled indexing

**Index vault for retrieval** is incremental: it stores each note's `TFile.stat` `[mtime, size]` in `index-state.json` (plugin folder) and re-embeds only notes whose values changed, deleting chunks for removed or renamed paths. The stat data is already in memory, so detecting changes reads no files. A fingerprint is saved only after the note's chunks are stored. **Full re-index of vault** ignores fingerprints, and changing the store, collection, embedding settings or chunking forces a full run.

A timer checks every five minutes against persisted timestamps. Settings: **Auto-index interval (hours)**, default 1, runs an incremental index; **Full re-index interval (days)**, default 7, runs a full one. `0` disables either. Scheduling only starts after one successful manual index, is skipped while retrieval is off, and a failed run waits for the next interval. Edits that keep both mtime and size are caught by the full re-index.

## Skills

A skill is reusable instructions plus a context mode (`active`, `retrieval` or `none`). Built-ins: Summarize note, Extract action items, Find related notes. Add your own as Markdown files in `<vault>/LLM Skills/` or `<vault>/.obsidian/plugins/llms-for-obsidian/skills/`; the file name is the skill name and the body is the instruction. Optional front matter: `description:` and `context:`. Run one with the **Run skill** command (the result becomes a new note) or pick it in the chat panel. Skill files are instructions sent to your chat endpoint.

## Database size and embedding tracking

The settings page shows indexed notes, chunks and, for SQLite, text and file size. SQLite also records each collection's embedding provider, URL, model and dimensions, shows them with a warning if they differ from current settings, and offers **Reset collection** (click twice) to clear it for reindexing. ChromaDB shows counts only.

## Live OpenRouter tests

`test/openrouter.live.js` calls OpenRouter chat and embeddings with tiny token caps, and is skipped without `OPENROUTER_API_KEY`. CI passes the `openrouter_sk` repo secret (monthly budget $2.5) in `.github/workflows/test.yml` for pushes, PRs and a weekly run. Override models with `OPENROUTER_CHAT_MODEL` / `OPENROUTER_EMBEDDING_MODEL`.

## Privacy and limitations

With defaults, note contents stay on the local services. Changing an endpoint to a remote service sends the relevant data to that service: indexing sends non-archive Markdown chunks to the embedding endpoint and, when selected, the ChromaDB endpoint; retrieval sends the question to the embedding endpoint; chat sends the question, conversation history and selected context (retrieved excerpts or the entire active note) to the chat endpoint; wiki generation sends the active note and excerpts to the chat endpoint. API keys are stored **unencrypted** in Obsidian's plugin data. Both vector stores retain note text and vectors; secure their files and network access. Only configure endpoints you trust.

Retrieved notes are untrusted input and may contain misleading instructions. The plugin tells the model to treat them as data, but cannot guarantee prompt-injection resistance or factual answers. Review generated content and citations before relying on them. Retrieval and wiki generation require an available, indexed collection; errors are shown rather than silently switching providers.

## Development and verification

Run `npm ci` and `npm test` with Node.js 18 or newer and an extension-enabled `sqlite3` CLI on PATH. The source modules are in `src/`; `npm run build` (esbuild with Svelte for the settings panel) bundles them into the distributable `main.js`, which is checked in and must be rebuilt after source changes. SQLite integration tests use the real database and sqlite-vec binary; Obsidian and HTTP services are mocked. These do not replace a smoke test in Obsidian with the selected storage backend and model services. For a manual check, index a small vault, search and open a note, try both chat context modes, restore an archived chat, and generate a wiki page. Rename or delete a note, reindex, and verify old results are gone.