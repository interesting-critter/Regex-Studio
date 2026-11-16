# Regex Studio

**Regex Studio** is a text transformation tool for Lumiverse. It lets you find, replace, and clean up text across single character cards, multiple cards at once, world books, or a custom scratchpad using regex patterns and reusable multi-step pipelines.

---

## What It Does

* **Edit Across Multiple Sources**: Work on a single character card, batch-edit dozens of cards at once, update lorebook entries, or any other text in a blank scratchpad.
* **Tag & Field Filtering**: Filter characters by include/exclude tags, and choose exactly which fields to load (greetings, descriptions, dialogue, system prompts, etc.).
* **Find & Replace**: Regex or plain-text search with full flag toggles (`g`, `i`, `m`, `s`), match navigation (`◀` / `▶`), and automatic scroll-to-match highlighting.
* **Pipeline Presets**: Chain multiple regex steps together into a sequential pipeline. Save and manage presets to re-run complex formatting passes with one click.
* **Diff Preview Before Saving**: Review exact word-level deletions and additions before applying changes, with checkboxes to exclude individual fields from the update.
* **Safe Editing**: Full undo/redo history, copy-all to clipboard, and instant reset back to original text. Nothing is truly edited until you hit save.

---

## Quick Start

1. Pick a Source (Character, Batch, Lorebook, or Custom).
2. Choose your fields and use tag filters to narrow down cards.
3. Set your pattern under **Find / Replace**, or switch to Presets to run a saved pipeline.
4. Hit Replace All (or step through single matches with Replace).
5. Inspect the changes in the Diff Preview and click Save Changes when you're satisfied.

---

## Performance & Save Semantics

* Batch saves go through `spindle.batch` (single transaction, ≤64 ops / under 1 MiB per chunk). All-or-nothing holds per chunk (multi-chunk or per-entity fallback saves over the 64-op/1 MiB host limit are not all-or-nothing); beyond 64 ops a revision conflict can leave earlier chunks committed, so check the toast and reopen the lorebook to verify. If the host lacks `spindle.batch`, saves fall back to per-entity calls automatically.
* Lorebook saves send `expected_revisions`; a conflict rolls the batch back and reports `revision_conflict` — nothing is silently overwritten. Re-select the lorebook from the dropdown to reload it from the server (local edits are discarded).
* Lists and cards are cached for 60s per user; the character-list Refresh sends `force: true` to bypass (world-book lists have no force parameter). Presets persist atomically (tmp file + rename).
* Lorebook `save_success` carries fresh `revisions`, so repeat saves in one session don't false-conflict after Regex Studio's own writes.

### Frontend save behavior

* Saves transmit only fields that changed since the last save (dirty-only patches); zero-change cards are skipped, and a "Nothing to save" toast appears when there is nothing to send.
* Lorebook saves attach `expected_revisions` for the dirty entries only; a conflict aborts the whole batch and shows the backend's message verbatim — the editor is left untouched.
* After a save the editor keeps local state — no post-save refetch, no flicker, caret and undo history survive. Diff previews hydrate lazily on first expand (badge shows `…` until then).
* Batch saves do not emit per-card `CHARACTER_EDITED` events; other Lumiverse views refresh on navigation/remount. Still requires Lumiverse 1.2.4+.
