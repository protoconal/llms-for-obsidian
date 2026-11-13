<script>
  import { MarkdownRenderer } from "obsidian";
  import { tick } from "svelte";

  let { session, app, owner, recommendModel } = $props();

  let state = $state(snapshot());
  let draft = $state("");
  let menuOpen = $state(false);
  let scroller;
  let input;
  let copied = $state(-1);

  function snapshot() {
    return {
      transcript: session.transcript, busy: session.busy, dirty: session.dirty, contextMode: session.contextMode,
      skillId: session.skillId, skills: session.skills, results: session.results, hasMessages: session.messages.length > 0
    };
  }
  $effect(() => session.subscribe(async () => {
    state = snapshot();
    await tick();
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }));

  $effect(() => {
    draft;
    if (input) { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
  });

  const advice = $derived(draft.trim() ? recommendModel(draft) : "");

  async function submit() {
    const text = draft;
    if (!text.trim() || state.busy) return;
    draft = "";
    if (!(await session.send(text))) draft = text;
  }
  function onKey(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  }
  // Assistant replies are Markdown; render them with Obsidian so links, code and lists match the vault theme.
  function markdown(node, text) {
    const render = value => {
      node.empty?.();
      if (!MarkdownRenderer || !MarkdownRenderer.render) { node.textContent = value; return; }
      MarkdownRenderer.render(app, value, node, "", owner).catch(() => { node.textContent = value; });
    };
    render(text);
    return { update: render };
  }
  async function copy(text, index) {
    try { await navigator.clipboard.writeText(text); copied = index; setTimeout(() => { if (copied === index) copied = -1; }, 1200); }
    catch (_) { /* clipboard unavailable */ }
  }
  function menu(action) { menuOpen = false; action(); }
  const contexts = [["retrieval", "Vault embeddings"], ["active", "Active note"], ["none", "No context"]];
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<div class="chat">
  <header>
    <div class="title">
      <span class="dot" class:busy={state.busy}></span>
      <strong>LLM Chat</strong>
      {#if state.dirty}<span class="badge" title="Unsaved changes">unsaved</span>{/if}
    </div>
    <div class="menu-wrap">
      <button class="icon" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={menuOpen}
        onclick={e => { e.stopPropagation(); menuOpen = !menuOpen; }}>⋯</button>
      {#if menuOpen}
        <div class="menu" role="menu" tabindex="-1" onclick={e => e.stopPropagation()} onkeydown={e => e.key === "Escape" && (menuOpen = false)}>
          <button role="menuitem" disabled={state.busy} onclick={() => menu(() => session.compact())}>Compact conversation</button>
          <button role="menuitem" disabled={state.busy || !state.hasMessages} onclick={() => menu(() => session.save())}>Save archive</button>
          <button role="menuitem" disabled={state.busy || !state.hasMessages} onclick={() => menu(() => session.saveCopy())}>Save as new copy</button>
          <button role="menuitem" disabled={state.busy} onclick={() => menu(() => session.restore())}>Restore archive…</button>
          <hr />
          <button role="menuitem" class="danger" disabled={state.busy} onclick={() => menu(() => session.clear())}>Clear conversation</button>
        </div>
      {/if}
    </div>
  </header>

  <div class="transcript" bind:this={scroller} aria-live="polite">
    {#if !state.transcript.length}
      <div class="empty">
        <div class="empty-icon">💬</div>
        <p><strong>Ask about your vault</strong></p>
        <p class="muted">Answers use the context source selected below. Press Enter to send, Shift+Enter for a new line.</p>
      </div>
    {/if}
    {#each state.transcript as message, i (i)}
      <div class="row {message.role}">
        <div class="bubble {message.role}">
          {#if message.role === "assistant"}
            <div class="md" use:markdown={message.content}></div>
          {:else}
            <div class="plain">{message.content}</div>
          {/if}
        </div>
        {#if message.role === "assistant"}
          <button class="copy" onclick={() => copy(message.content, i)}>{copied === i ? "Copied" : "Copy"}</button>
        {/if}
      </div>
    {/each}
    {#if state.busy}
      <div class="row assistant"><div class="bubble assistant typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>
    {/if}
  </div>

  {#if state.results}
    <section class="results">
      <div class="results-head">
        <span>{state.results.items.length} match{state.results.items.length === 1 ? "" : "es"} for “{state.results.query}”</span>
        <button class="icon small" aria-label="Close results" onclick={() => session.closeResults()}>✕</button>
      </div>
      {#each state.results.items as item (item.path)}
        <button class="result" onclick={() => session.openResult(item.file)}>
          <span class="path">{item.path}</span>
          <span class="excerpt">{item.excerpt}</span>
        </button>
      {:else}
        <p class="muted pad">No matches found.</p>
      {/each}
    </section>
  {/if}

  <footer>
    <div class="chips">
      <div class="segmented" role="radiogroup" aria-label="Chat context">
        {#each contexts as [value, label]}
          <button role="radio" aria-checked={state.contextMode === value} class:active={state.contextMode === value}
            disabled={state.busy} onclick={() => session.setContext(value)}>{label}</button>
        {/each}
      </div>
      <select aria-label="Skill" value={state.skillId} disabled={state.busy} onchange={e => session.setSkill(e.currentTarget.value)}>
        <option value="">No skill</option>
        {#each state.skills as skill (skill.id)}<option value={skill.id} title={skill.description}>{skill.name}</option>{/each}
      </select>
    </div>
    <div class="composer">
      <textarea rows="1" aria-label="Chat message" placeholder="Message your vault…" bind:value={draft} onkeydown={onKey} bind:this={input}></textarea>
      <div class="actions">
        <button class="ghost" disabled={state.busy || !draft.trim()} title="Search note text for this phrase" onclick={() => session.search(draft)}>Search notes</button>
        <button class="send" disabled={state.busy || !draft.trim()} onclick={submit}>{state.busy ? "Sending…" : "Send"}</button>
      </div>
    </div>
    {#if advice}<p class="advice">{advice}</p>{/if}
  </footer>
</div>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 0; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px 8px; border-bottom: 1px solid var(--background-modifier-border); }
  .title { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-green, #4caf50); }
  .dot.busy { background: var(--color-orange, #ff9800); animation: pulse 1s ease-in-out infinite; }
  .badge { font-size: var(--font-ui-smaller); color: var(--text-warning, var(--text-muted)); border: 1px solid currentColor; border-radius: 10px; padding: 0 7px; }
  .menu-wrap { position: relative; }
  .icon { background: transparent; box-shadow: none; border: none; font-size: 18px; line-height: 1; padding: 4px 8px; color: var(--text-muted); cursor: pointer; }
  .icon:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
  .icon.small { font-size: 12px; padding: 2px 6px; }
  .menu { position: absolute; right: 0; top: 100%; z-index: 10; min-width: 190px; padding: 4px; display: flex; flex-direction: column;
    background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 8px; box-shadow: var(--shadow-s); }
  .menu button { text-align: left; background: transparent; box-shadow: none; border: none; padding: 6px 10px; height: auto; border-radius: 5px; cursor: pointer; }
  .menu button:hover:not(:disabled) { background: var(--background-modifier-hover); }
  .menu button:disabled { opacity: 0.45; cursor: default; }
  .menu .danger { color: var(--text-error); }
  .menu hr { margin: 4px 0; border: none; border-top: 1px solid var(--background-modifier-border); }

  .transcript { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px 4px; }
  .empty { margin: auto; text-align: center; max-width: 260px; color: var(--text-muted); }
  .empty p { margin: 4px 0; }
  .empty-icon { font-size: 32px; opacity: 0.7; }
  .muted { color: var(--text-muted); font-size: var(--font-ui-small); }
  .row { display: flex; flex-direction: column; gap: 2px; max-width: 100%; }
  .row.user { align-items: flex-end; }
  .row.assistant, .row.error { align-items: flex-start; }
  .bubble { max-width: 94%; padding: 8px 12px; border-radius: 14px; line-height: 1.5; user-select: text; overflow-wrap: anywhere; }
  .bubble.user { background: var(--interactive-accent); color: var(--text-on-accent); border-bottom-right-radius: 4px; }
  .bubble.assistant { background: var(--background-secondary); border-bottom-left-radius: 4px; }
  .bubble.error { background: var(--background-modifier-error); color: var(--text-on-accent); border-bottom-left-radius: 4px; }
  .plain { white-space: pre-wrap; }
  .md > :global(:first-child) { margin-top: 0; }
  .md > :global(:last-child) { margin-bottom: 0; }
  .md :global(pre) { overflow-x: auto; }
  .copy { background: transparent; box-shadow: none; border: none; height: auto; padding: 0 6px; font-size: var(--font-ui-smaller); color: var(--text-faint); cursor: pointer; opacity: 0; transition: opacity 0.15s; }
  .row:hover .copy, .copy:focus-visible { opacity: 1; }
  .typing { display: flex; gap: 4px; padding: 12px 14px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: bounce 1.2s infinite ease-in-out; }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }

  .results { max-height: 35%; overflow-y: auto; margin: 4px 0; border: 1px solid var(--background-modifier-border); border-radius: 8px; background: var(--background-secondary); }
  .results-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; font-size: var(--font-ui-smaller); color: var(--text-muted); position: sticky; top: 0; background: var(--background-secondary); }
  .result { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; height: auto; text-align: left; white-space: normal;
    background: transparent; box-shadow: none; border: none; border-top: 1px solid var(--background-modifier-border); border-radius: 0; padding: 6px 10px; cursor: pointer; }
  .result:hover { background: var(--background-modifier-hover); }
  .path { color: var(--text-accent); font-size: var(--font-ui-small); }
  .excerpt { color: var(--text-muted); font-size: var(--font-ui-smaller); }
  .pad { padding: 4px 10px; }

  footer { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--background-modifier-border); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .segmented { display: inline-flex; background: var(--background-secondary); border-radius: 8px; padding: 2px; }
  .segmented button { background: transparent; box-shadow: none; border: none; height: auto; padding: 3px 9px; font-size: var(--font-ui-smaller); color: var(--text-muted); border-radius: 6px; cursor: pointer; }
  .segmented button.active { background: var(--background-primary); color: var(--text-normal); box-shadow: var(--shadow-s); }
  .chips select { font-size: var(--font-ui-smaller); height: auto; padding: 3px 24px 3px 8px; max-width: 140px; }
  .composer { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 12px; background: var(--background-primary); }
  .composer:focus-within { border-color: var(--interactive-accent); box-shadow: 0 0 0 2px var(--background-modifier-active-hover, transparent); }
  textarea { width: 100%; resize: none; border: none; background: transparent; box-shadow: none; padding: 2px 4px; max-height: 200px; }
  textarea:focus { box-shadow: none; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  .ghost { background: transparent; box-shadow: none; color: var(--text-muted); }
  .send { background: var(--interactive-accent); color: var(--text-on-accent); }
  .send:disabled { opacity: 0.5; }
  .advice { margin: 0; color: var(--text-faint); font-size: var(--font-ui-smaller); }

  @keyframes pulse { 50% { opacity: 0.35; } }
  @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-4px); opacity: 1; } }
</style>
