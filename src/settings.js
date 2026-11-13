const { PluginSettingTab, Setting } = require("obsidian");
const { mount, unmount } = require("svelte");
const StoragePanel = require("./StoragePanel.svelte").default;

const DEFAULTS = {
  chatProvider: "ollama",
  chatUrl: "http://127.0.0.1:11434",
  chatModel: "llama3.2",
  chatKey: "",
  chatMaxTokens: 0,
  embeddingProvider: "ollama",
  embeddingUrl: "http://127.0.0.1:11434",
  embeddingModel: "nomic-embed-text",
  embeddingKey: "",
  chromaUrl: "http://127.0.0.1:8000",
  chromaTenant: "default_tenant",
  chromaDatabase: "default_database",
  collection: "obsidian-notes",
  vectorStore: "local",
  useRetrieval: true,
  autoIndexHours: 1,
  fullReindexDays: 7
};

const TABS = [
  ["chat", "Chat"],
  ["embeddings", "Embeddings"],
  ["storage", "Storage"],
  ["indexing", "Indexing"]
];

class LLMSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.tab = "chat";
  }
  display() {
    const { containerEl: el } = this;
    this.hide();
    el.empty();
    el.addClass("llms-settings");
    el.createEl("h2", { text: "LLMs for Obsidian" });
    el.createDiv({ cls: "llms-notice", text: "API keys are stored unencrypted in plugin data. Remote endpoints receive your prompts and any retrieved vault excerpts." });
    const nav = el.createDiv({ cls: "llms-tabs", attr: { role: "tablist" } });
    const body = el.createDiv({ cls: "llms-tab-body" });
    for (const [id, label] of TABS) {
      const button = nav.createEl("button", { text: label, cls: "llms-tab" + (id === this.tab ? " is-active" : ""), attr: { role: "tab" } });
      button.onclick = () => { this.tab = id; this.display(); };
    }
    this[this.tab + "Tab"](body);
  }
  text(el, name, description, key, password = false) {
    const { plugin } = this;
    new Setting(el).setName(name).setDesc(description).addText(t => {
      t.setValue(plugin.settings[key]).onChange(async value => { plugin.settings[key] = value.trim(); await plugin.saveSettings(); });
      if (password) t.inputEl.type = "password";
    });
  }
  number(el, name, description, key, integer = false) {
    const { plugin } = this;
    new Setting(el).setName(name).setDesc(description).addText(t => t.setValue(String(plugin.settings[key])).onChange(async value => {
      const n = Number(value);
      plugin.settings[key] = Number.isFinite(n) && n > 0 ? (integer ? Math.floor(n) : n) : 0;
      await plugin.saveSettings();
    }));
  }
  provider(el, name, key) {
    const { plugin } = this;
    new Setting(el).setName(name).addDropdown(d => d
      .addOption("ollama", "Ollama").addOption("openai", "OpenAI-compatible")
      .setValue(plugin.settings[key]).onChange(async value => { plugin.settings[key] = value; await plugin.saveSettings(); }));
  }
  chatTab(el) {
    const { plugin } = this;
    new Setting(el).setName("Connection").setHeading();
    new Setting(el).setName("OpenRouter preset").setDesc("Sets the chat provider and URL; enter your model and API key below.")
      .addButton(b => b.setButtonText("Use OpenRouter").onClick(async () => {
        plugin.settings.chatProvider = "openai";
        plugin.settings.chatUrl = "https://openrouter.ai/api/v1";
        await plugin.saveSettings();
        this.display();
      }));
    this.provider(el, "Chat provider", "chatProvider");
    this.text(el, "Base URL", "Ollama root or OpenAI-compatible API base, including /v1.", "chatUrl");
    this.text(el, "Model", "Model name as understood by the endpoint.", "chatModel");
    this.text(el, "API key", "Optional bearer token.", "chatKey", true);
    new Setting(el).setName("Behavior").setHeading();
    this.number(el, "Max reply tokens", "Caps chat reply length; 0 leaves it to the provider.", "chatMaxTokens", true);
    new Setting(el).setName("Use retrieval in chat").setDesc("Embed each question and send matching excerpts to the chat endpoint.")
      .addToggle(t => t.setValue(plugin.settings.useRetrieval).onChange(async value => {
        plugin.settings.useRetrieval = value; await plugin.saveSettings();
      }));
  }
  embeddingsTab(el) {
    new Setting(el).setName("Embedding connection").setHeading();
    this.provider(el, "Embedding provider", "embeddingProvider");
    this.text(el, "Base URL", "Ollama root or OpenAI-compatible API base, including /v1.", "embeddingUrl");
    this.text(el, "Model", "Use the same model for indexing and searching.", "embeddingModel");
    this.text(el, "API key", "Optional bearer token.", "embeddingKey", true);
  }
  storageTab(el) {
    const { plugin } = this;
    new Setting(el).setName("Vector store").setHeading();
    new Setting(el).setName("Backend").setDesc("The built-in index needs no setup and works on desktop and mobile. The others are optional.")
      .addDropdown(d => d.addOption("local", "Built-in (no setup)").addOption("chroma", "ChromaDB server").addOption("sqlite", "SQLite + sqlite-vec (advanced)")
        .setValue(plugin.settings.vectorStore).onChange(async value => { plugin.settings.vectorStore = value; await plugin.saveSettings(); this.display(); }));
    this.text(el, "Collection", "Use a separate collection for each vault and embedding model.", "collection");
    if (plugin.settings.vectorStore === "chroma") {
      this.text(el, "ChromaDB URL", "ChromaDB v2 server URL.", "chromaUrl");
      this.text(el, "ChromaDB tenant", "Existing tenant name.", "chromaTenant");
      this.text(el, "ChromaDB database", "Existing database name.", "chromaDatabase");
    } else if (plugin.settings.vectorStore === "sqlite") {
      el.createDiv({ cls: "llms-notice", text: "SQLite requires desktop, a separately installed SQLite CLI and the sqlite-vec extension. See the README. The plugin runs one background sqlite3 process per database, started on first use." });
    }
    if (plugin.settings.vectorStore === "sqlite" || plugin.sqliteServers().length) this.sqliteServerSetting(el);
    this.panel = el.createDiv();
    this.component = mount(StoragePanel, { target: this.panel, props: { load: () => plugin.storageStats(), reset: () => plugin.resetCollection() } });
  }
  sqliteServerSetting(el) {
    const { plugin } = this;
    const setting = new Setting(el).setName("SQLite background server");
    const describe = () => {
      const servers = plugin.sqliteServers();
      setting.setDesc(servers.length
        ? servers.map(s => `Running (pid ${s.pid}, ${s.requests} requests since ${new Date(s.startedAt).toLocaleTimeString()}): ${s.databasePath}`).join("\n") + "\nIt restarts automatically on the next index or search."
        : "Not running. It starts automatically on the next index, search or stats request.");
    };
    describe();
    setting.addButton(b => b.setButtonText("Refresh").onClick(describe));
    setting.addButton(b => b.setButtonText("Kill server").setWarning().onClick(() => { plugin.stopSqliteServers(); describe(); }));
  }
  indexingTab(el) {
    new Setting(el).setName("Schedule").setHeading();
    this.number(el, "Auto-index interval (hours)", "Re-embeds only notes whose modified time or size changed. 0 disables. Starts after your first manual index.", "autoIndexHours");
    this.number(el, "Full re-index interval (days)", "Re-embeds every note to catch edits that keep the same modified time and size. 0 disables.", "fullReindexDays");
    new Setting(el).setName("Actions").setHeading();
    new Setting(el).setName("Index vault now").setDesc("Embeds new and changed notes.")
      .addButton(b => b.setButtonText("Index").setCta().onClick(() => this.plugin.runIndex()));
    new Setting(el).setName("Full re-index").setDesc("Re-embeds every note.")
      .addButton(b => b.setButtonText("Full re-index").onClick(() => this.plugin.runIndex({ full: true })));
  }
  hide() {
    if (this.component) { unmount(this.component); this.component = null; }
  }
}

module.exports = { LLMSettings, DEFAULTS };
