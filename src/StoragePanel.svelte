<script>
  import { formatBytes } from "./format.js";

  let { load, reset } = $props();
  let confirming = $state(false);
  let stats = $state(null);
  let error = $state("");
  let loading = $state(false);

  async function refresh() {
    loading = true;
    error = "";
    try { stats = await load(); }
    catch (e) { stats = null; error = e.message; }
    finally { loading = false; }
  }
  async function doReset() {
    if (!confirming) { confirming = true; return; }
    confirming = false;
    try { await reset(); } catch (e) { error = e.message; return; }
    await refresh();
  }
  refresh();
</script>

<div class="llms-storage">
  <h3>Database size</h3>
  <button onclick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
  {#if error}
    <p class="llms-storage-error">{error}</p>
  {:else if stats}
    <table>
      <tbody>
        <tr><th>Store</th><td>{stats.store}</td></tr>
        <tr><th>Indexed notes</th><td>{stats.notes}</td></tr>
        <tr><th>Chunks</th><td>{stats.chunks}</td></tr>
        {#if stats.textBytes !== null}
          <tr><th>Chunk text</th><td>{formatBytes(stats.textBytes)}</td></tr>
        {/if}
        {#if stats.fileBytes !== null}
          <tr><th>Database file</th><td>{formatBytes(stats.fileBytes)}</td></tr>
        {:else}
          <tr><th>Database file</th><td>Not available for this store</td></tr>
        {/if}
      </tbody>
    </table>
    {#if stats.embedding}
      <p>Embedding recorded in database: {stats.embedding.provider} · {stats.embedding.model} · {stats.embedding.dimensions} dimensions<br />{stats.embedding.url}</p>
      {#if !stats.embedding.matches}
        <p class="llms-storage-error">These differ from your current embedding settings. Reset the collection and reindex, or use a new collection name.</p>
      {/if}
    {/if}
    {#if stats.canReset}
      <button onclick={doReset}>{confirming ? "Click again to delete all indexed data" : "Reset collection"}</button>
    {/if}
  {/if}
</div>
