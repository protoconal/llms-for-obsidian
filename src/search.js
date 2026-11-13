const { isArchivePath } = require("./archive");

async function searchNotes(vault, query, limit = 50) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const results = [];
  for (const file of vault.getMarkdownFiles()) {
    if (isArchivePath(file.path)) continue;
    const text = await vault.cachedRead(file);
    const index = text.toLowerCase().indexOf(term);
    if (index < 0) continue;
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + term.length + 80);
    results.push({ file, excerpt: (start ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "") });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = { searchNotes };
