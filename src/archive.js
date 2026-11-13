const { FuzzySuggestModal } = require("obsidian");

const ARCHIVE_FOLDER = "LLM Chat Archives";

function isArchivePath(path) {
  return typeof path === "string" && (path === ARCHIVE_FOLDER || path.startsWith(ARCHIVE_FOLDER + "/"));
}

function parseArchive(content) {
  const data = JSON.parse(content);
  const validMessages = messages => Array.isArray(messages) && messages.every(message =>
    message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string");
  if (!data || data.version !== 1 || typeof data.summary !== "string" ||
      !validMessages(data.history) || !validMessages(data.messages)) {
    throw new Error("Invalid or unsupported chat archive.");
  }
  return { summary: data.summary, history: data.history, messages: data.messages };
}

class ChatArchives {
  constructor(vault) { this.vault = vault; }
  list() {
    return this.vault.getFiles().filter(file => isArchivePath(file.path) && file.extension === "json")
      .sort((a, b) => b.path.localeCompare(a.path));
  }
  async load(file) {
    if (!file || !isArchivePath(file.path) || file.extension !== "json") throw new Error("Not a chat archive.");
    const content = await this.vault.read(file);
    return { ...parseArchive(content), file, content };
  }
  async save(state, previous) {
    const content = JSON.stringify({ version: 1, summary: state.summary, history: state.history, messages: state.messages }, null, 2) + "\n";
    if (previous) {
      if (!isArchivePath(previous.file.path) || previous.file.extension !== "json" ||
          this.vault.getAbstractFileByPath(previous.file.path) !== previous.file) {
        throw new Error("The archive was moved or deleted. Restore it again before saving.");
      }
      await this.vault.process(previous.file, current => {
        if (current !== previous.content) throw new Error("The archive changed externally. Restore it again before saving.");
        return content;
      });
      return { file: previous.file, content };
    }
    if (!this.vault.getAbstractFileByPath(ARCHIVE_FOLDER)) await this.vault.createFolder(ARCHIVE_FOLDER);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let path = `${ARCHIVE_FOLDER}/${stamp}.json`, suffix = 1;
    while (this.vault.getAbstractFileByPath(path)) path = `${ARCHIVE_FOLDER}/${stamp}-${suffix++}.json`;
    const file = await this.vault.create(path, content);
    return { file, content };
  }
}

class ArchivePicker extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a chat archive to restore");
  }
  getItems() { return this.files; }
  getItemText(file) { return file.path; }
  onChooseItem(file) { return this.onChoose(file); }
}

module.exports = { ARCHIVE_FOLDER, isArchivePath, parseArchive, ChatArchives, ArchivePicker };
