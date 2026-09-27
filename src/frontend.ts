import type { SpindleFrontendContext, SpindleSelectHandle, SpindleMultiSelectHandle } from 'lumiverse-spindle-types'
import { showDiffPreviewModal, type FieldDiffItem } from './diff-modal'
import { PipelineManagerUI, runPipelineOnText } from './pipeline-manager'
import type { RegexPreset } from './pipeline-types'
import {
  filterCharactersByTags,
  mountTagFilterControls,
  type CharacterItemWithTags,
  type TagFilterMountResult,
} from './tag-filter'
import {
  buildBatchCharacterFields,
  assembleBatchPatches,
  type BatchFieldItem,
} from './batch-manager'

const CHAR_FIELDS = [
  { key: 'first_mes', label: 'First Message' },
  { key: 'alternate_greetings', label: 'Alt Greetings' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'mes_example', label: 'Example Dialogue' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History' },
  { key: 'creator_notes', label: 'Creator Notes' },
] as const

type SourceMode = 'character' | 'character_batch' | 'lorebook' | 'custom'
type TabView = 'editor' | 'pipelines'

interface FieldItem {
  id: string
  key: string
  label: string
  value: string
  sublabel?: string
}

interface RegexMatch {
  fieldId: string
  fieldIndex: number
  startIndex: number
  length: number
  text: string
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function setup(ctx: SpindleFrontendContext) {
  let activeTabView: TabView = 'editor'
  let currentSourceMode: SourceMode = 'character'
  let isPresetRunMode = false

  let rawCharacters: CharacterItemWithTags[] = []
  let worldBooks: Array<{ id: string; name: string }> = []
  let presets: RegexPreset[] = []
  let selectedPresetId = ''

  let selectedChar: any = null
  let selectedBatchChars: any[] = []
  let selectedWorldBookEntries: any[] = []
  let selectedItemId = ''
  let selectedBatchIds: string[] = []

  let singleSelectComp: SpindleSelectHandle | null = null
  let multiSelectComp: SpindleMultiSelectHandle | null = null
  let tagFilterComp: TagFilterMountResult | null = null
  let pipelineUI: PipelineManagerUI | null = null

  let fields: FieldItem[] = []
  const enabledFields = new Set<string>([
    'first_mes',
    'alternate_greetings',
    'description',
    'personality',
    'scenario',
  ])

  // Single Regex & Navigation State
  let useRegex = true
  let previewDiffEnabled = true
  const flags = { g: true, i: false, m: true, s: true }
  let currentMatches: RegexMatch[] = []
  let currentMatchIndex = -1

  // Field expansion state
  let fieldsExpanded = localStorage.getItem('regex-studio-fields-expanded') === 'true'
  let autoOpenedFieldId: string | null = null

  // Undo / Redo History Stack
  let historyStack: FieldItem[][] = [[]]
  let historyIndex = 0
  const MAX_HISTORY = 100
  let typingTimer: ReturnType<typeof setTimeout> | null = null

  // ── Register Drawer Tab ──
  const tab = ctx.ui.registerDrawerTab({
    id: 'regex_studio',
    title: 'Regex Studio',
    shortName: 'Rgx Studio',
    description: 'Multi-field regex & pipeline editor for cards, lorebooks, and custom text',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>`,
  })

  // Keep the drawer tab itself bounded so the editor can own its internal scroll area.
  tab.root.style.height = '100%'
  tab.root.style.minHeight = '0'
  tab.root.style.overflow = 'hidden'

  // ── Styles ──
  const removeStyle = ctx.dom.addStyle(`
    /* CSS: Main Regex Studio wrapper; vertical layout, spacing, padding, and base text styling. */
    .rs-container { display: flex; flex-direction: column; gap: 10px; padding: 12px; font-size: 13px; color: var(--lumiverse-text); height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; }
    /* CSS: Generic horizontal flex row used throughout the UI; wraps on narrow screens. */
    .rs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    /* CSS: Keep the editor workspace fixed while only the field list scrolls. */
    #rs-view-editor { overflow: hidden; min-height: 0; height: 0; flex: 1 1 auto; }
    /* CSS: Keep the regex controls and action toolbar visible above the scrolling fields. */
    #rs-regex-card { flex-shrink: 0; }
    #rs-view-editor > .rs-row, #rs-view-editor > .rs-settings-details, #rs-view-editor > .rs-action-toolbar { flex-shrink: 0; }
    .rs-action-toolbar { flex-shrink: 0; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; }
    .rs-action-toolbar .rs-btn { flex-shrink: 0; }
    .rs-action-toolbar::-webkit-scrollbar { display: none; }
    .rs-action-toolbar { scrollbar-width: none; }
    /* CSS: Small bold heading used for labels such as "Source:". */
    .rs-header-title { font-weight: 600; font-size: 13.5px; }
    /* CSS: Shared appearance for text inputs and select controls. */
    .rs-input { background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 10px; font-size: 12px; outline: none; box-sizing: border-box; }
    /* CSS: Focus state for inputs/selects; highlights the active control with the accent color. */
    .rs-input:focus { border-color: var(--lumiverse-accent); }
    /* CSS: Base button style used for normal actions throughout Regex Studio. */
    .rs-btn { background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 5px 10px; font-size: 12px; cursor: pointer; transition: background 0.15s; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; }
    /* CSS: Hover state for enabled buttons. */
    .rs-btn:hover:not(:disabled) { background: var(--lumiverse-border); }
    /* CSS: Disabled-button state; dims the button and prevents normal pointer interaction. */
    .rs-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    /* CSS: Primary-action button style for the currently emphasized action. */
    .rs-btn-primary { background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg, #fff); border: 1px solid var(--lumiverse-accent); }
    /* CSS: Slightly dims a primary button on hover. */
    .rs-btn-primary:hover:not(:disabled) { opacity: 0.9; }
    
    /* CSS: Pill/chip control used for field filters, regex mode, and regex flags. */
    .rs-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border); border-radius: 12px; cursor: pointer; user-select: none; font-weight: 500; }
    /* CSS: Active chip state; visually marks a selected field/filter/regex option. */
    .rs-chip.active { background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg, #fff); border-color: var(--lumiverse-accent); }
    /* CSS: Disabled chip state for options unavailable in plain-text mode. */
    .rs-chip.disabled { opacity: 0.4; cursor: not-allowed; }
    
    /* CSS: Shared bordered panel/card container. */
    .rs-card { background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    /* CSS: Scrollable stack of editable character/lorebook text fields; fills remaining editor space. */
    .rs-fields-list { display: flex; flex-direction: column; gap: 12px; flex: 1 1 0; min-height: 0; height: 0; max-height: none; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding-right: 2px; }
    
    /* CSS: Individual editable-field panel containing a field header and textarea. */
    .rs-field-box { background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0; }
    /* CSS: Header strip for each editable field; shows field label and optional sublabel. */
    .rs-field-header { background: var(--lumiverse-fill-subtle); padding: 6px 10px; font-size: 11.5px; font-weight: 600; color: var(--lumiverse-text); display: flex; align-items: center; justify-content: space-between; border-bottom: none; cursor: pointer; user-select: none; }
    /* CSS: Secondary field metadata such as the card name or lorebook entry ID. */
    .rs-field-sub { font-size: 10.5px; font-weight: normal; color: var(--lumiverse-text-dim); }
    
    /* CSS: Main editor textarea; fixed starting height, monospace text, and vertical resize support. */
    .rs-field-textarea { width: 100%; min-height: 250px; height: 250px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.45; background: transparent; color: var(--lumiverse-text); border: none; padding: 8px 10px; resize: vertical; box-sizing: border-box; outline: none; }
    /* CSS: Focus state for an editor textarea; adds a subtle background to show active editing. */
    .rs-field-textarea:focus { background: var(--lumiverse-fill-subtle); }
    /* CSS: Text-selection highlight; uses the user-selected regex highlight color. */
    .rs-field-textarea::selection { background: var(--rs-highlight-color, rgba(109, 93, 252, 0.45)); color: inherit; }

    /* CSS: Circular color-picker control used to choose the match-selection highlight color. */
    .rs-color-swatch { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--lumiverse-border); cursor: pointer; padding: 0; background: none; -webkit-appearance: none; appearance: none; }
    /* CSS: Removes WebKit's default padding around the native color swatch. */
    .rs-color-swatch::-webkit-color-swatch-wrapper { padding: 0; }
    /* CSS: Makes the native WebKit color swatch fill the circular picker cleanly. */
    .rs-color-swatch::-webkit-color-swatch { border: none; border-radius: 50%; }

    /* CSS: Collapsible settings group containing tag filters, source selection, and field selection. */
    .rs-settings-details { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); overflow: hidden; flex-shrink: 0; }
    /* CSS: Compact summary row used to open/close the settings group. */
    .rs-settings-summary { padding: 7px 10px; cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; color: var(--lumiverse-text); list-style: none; display: flex; align-items: center; gap: 7px; }
    .rs-settings-summary::-webkit-details-marker { display: none; }
    .rs-settings-summary::before { content: '▶'; color: var(--lumiverse-accent); font-size: 10px; }
    .rs-settings-details[open] > .rs-settings-summary::before { content: '▼'; }
    /* CSS: Interior spacing for the controls revealed by the settings dropdown. */
    .rs-settings-content { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid var(--lumiverse-border); }

    /* CSS: Container for the Editor / Pipelines & Presets navigation tabs. */
    .rs-nav-tabs { display: flex; border-bottom: 1px solid var(--lumiverse-border); margin-bottom: 4px; }
    /* CSS: Individual top-level navigation tab; inactive tabs use dim text and a transparent underline. */
    .rs-nav-tab { padding: 6px 14px; font-weight: 600; font-size: 12.5px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--lumiverse-text-dim); }
    /* CSS: Active top-level navigation tab; accent text and underline identify the current view. */
    .rs-nav-tab.active { color: var(--lumiverse-accent); border-bottom-color: var(--lumiverse-accent); }
  `)

  // ── Render HTML Shell ──
  tab.root.innerHTML = `
    <div class="rs-container">
      <!-- HTML: Top navigation for switching between the text editor and pipeline builder. -->
      <!-- CSS: .rs-nav-tabs/.rs-nav-tab/.active control layout and active-tab appearance. -->
      <div class="rs-nav-tabs">
        <!-- HTML: Opens the main multi-field regex editor view. -->
        <div class="rs-nav-tab active" id="rs-tab-editor">Editor</div>
        <!-- HTML: Opens the pipeline/preset management view. -->
        <div class="rs-nav-tab" id="rs-tab-pipelines">Pipelines & Presets</div>
      </div>

      <!-- HTML: TAB VIEW 1 — complete editor workspace. -->
      <!-- CSS: inline flex-column layout stacks source, filters, regex controls, and fields. -->
      <div id="rs-view-editor" style="display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0;">
        <!-- HTML: Source-mode toolbar; chooses what kind of content Regex Studio edits. -->
        <div class="rs-row">
          <!-- HTML: Source label. -->
          <label class="rs-header-title">Source:</label>
          <!-- HTML: Edits one character card. -->
          <button class="rs-btn rs-btn-primary" id="rs-mode-char">Character</button>
          <!-- HTML: Enables multi-card/batch editing. -->
          <button class="rs-btn" id="rs-mode-batch">Character Batch</button>
          <!-- HTML: Edits lorebook/world-book entries. -->
          <button class="rs-btn" id="rs-mode-lore">Lorebook</button>
          <!-- HTML: Provides a standalone scratchpad/custom text editor. -->
          <button class="rs-btn" id="rs-mode-custom">Custom Text</button>
        </div>

        <!-- HTML: Collapsible settings dropdown containing tag filters, source selection, and field selection. -->
        <details class="rs-settings-details">
          <summary class="rs-settings-summary">Character &amp; Field Settings</summary>
          <div class="rs-settings-content">
            <!-- HTML: Tag filter panel; shown for character and character-batch modes. -->
            <div id="rs-tag-filters-section" class="rs-card">
              <!-- HTML/CSS: Section title for include/exclude character-tag filtering. -->
              <div style="font-weight: 500; font-size: 11.5px;">Tag Filters:</div>
              <!-- HTML: Mount point populated by tag-filter.ts with the two multi-select controls. -->
              <div id="rs-tag-controls-slot"></div>
            </div>

            <!-- HTML: Content-selection area; receives either a single-select or multi-select control. -->
            <div id="rs-selector-section" class="rs-row" style="align-items: stretch;">
              <!-- HTML/CSS: Mount point for the current character/lorebook selector or batch multi-select. -->
              <div id="rs-select-slot" style="flex: 1; min-width: 200px;"></div>
              <!-- HTML: Batch-only action that selects every currently filtered character. -->
              <button class="rs-btn" id="rs-select-all-btn" style="display: none;">Select All</button>
              <!-- HTML: Batch-only action that clears all selected characters. -->
              <button class="rs-btn" id="rs-deselect-all-btn" style="display: none;">Deselect All</button>
              <!-- HTML: Reloads the available characters/lorebooks from the backend. -->
              <button class="rs-btn" id="rs-refresh-btn">Refresh</button>
            </div>

            <!-- HTML: Field-filter panel; controls which character fields are loaded into the editor. -->
            <div id="rs-fields-filter" class="rs-card">
              <!-- HTML/CSS: Label explaining that the chips control editable character fields. -->
              <div style="font-weight: 500; font-size: 11.5px;">Include Fields in Editor:</div>
              <!-- HTML: Dynamic mount point where one chip is created for each CHAR_FIELDS definition. -->
              <div class="rs-row" id="rs-chips-container"></div>
            </div>
          </div>
        </details>

        <!-- HTML: Main editing action toolbar for history, copying, resetting, and saving. -->
        <!-- HTML: Compact single-row action toolbar; kept fixed above the scrolling field list. -->
        <div class="rs-row rs-action-toolbar">
          <!-- HTML: Undo/redo history controls. -->
          <button class="rs-btn" id="rs-undo-btn" title="Undo change" disabled>↶ Undo</button>
          <button class="rs-btn" id="rs-redo-btn" title="Redo change" disabled>↷ Redo</button>

          <!-- HTML: Opens or closes all editor fields. -->
          <button class="rs-btn" id="rs-toggle-fields-btn" title="Open or close all fields">
            ${fieldsExpanded ? 'Close All' : 'Open All'}
          </button>

          <!-- HTML: Copies all current field contents to the clipboard. -->
          <button class="rs-btn" id="rs-copy-btn">Copy All</button>
          <!-- HTML: Restores the selected source data back into the editor. -->
          <button class="rs-btn" id="rs-reset-btn">Reset All</button>
          <!-- HTML: Persists the current edits through the backend. -->
          <button class="rs-btn rs-btn-primary" id="rs-save-btn">Save Changes</button>
        </div>

        <!-- HTML: Regex/pipeline execution panel. This is the control center for single-regex replacement or preset execution. -->
        <div class="rs-card" id="rs-regex-card">
          <div class="rs-row" style="justify-content: space-between;">
            <div class="rs-row" id="rs-single-regex-flags">
              <!-- HTML: Toggles regex interpretation versus literal text matching. -->
              <label class="rs-chip active" id="rs-toggle-regex" title="Toggle Regular Expressions">.* Regex</label>
              <!-- HTML/CSS: Label introducing the regex flags. -->
              <span style="font-size: 11px; color: var(--lumiverse-text-dim); margin-left: 2px;">Flags:</span>
              <!-- HTML: Global-match flag toggle. -->
              <label class="rs-chip active" id="rs-flag-g" title="Global match">g</label>
              <!-- HTML: Case-insensitive flag toggle. -->
              <label class="rs-chip" id="rs-flag-i" title="Case insensitive">i</label>
              <!-- HTML: Multiline flag toggle. -->
              <label class="rs-chip active" id="rs-flag-m" title="Multiline">m</label>
              <!-- HTML: Dot-matches-newline flag toggle. -->
              <label class="rs-chip active" id="rs-flag-s" title="Dot matches newline">s</label>
              <!-- HTML/CSS: Label for the match-highlight color setting. -->
              <span style="font-size: 11px; color: var(--lumiverse-text-dim); margin-left: 4px;">Highlight:</span>
              <!-- HTML: Native color picker used to change the selection/highlight color. -->
              <!-- CSS: .rs-color-swatch turns the native picker into a small circular swatch. -->
              <input type="color" id="rs-color-picker" class="rs-color-swatch" value="#6d5dfc" title="Change match highlight color" />
            </div>

            <!-- HTML/CSS: Switches the execution panel between single-regex mode and preset/pipeline mode. -->
            <button class="rs-btn" id="rs-toggle-mode-btn" style="font-weight: 600; font-size: 11px;">⇄ Presets</button>
          </div>

          <!-- HTML: Single-regex input row; hidden when preset-run mode is active. -->
          <div id="rs-single-inputs-row" class="rs-row">
            <!-- HTML/CSS: Regex/literal search pattern input. -->
            <input type="text" id="rs-regex-find" class="rs-input" placeholder="Find text..." style="flex: 1; min-width: 140px;" />
            <!-- HTML/CSS: Replacement text or replacement expression input. -->
            <input type="text" id="rs-regex-replace" class="rs-input" placeholder="Replace with..." style="flex: 1; min-width: 140px;" />
          </div>

          <!-- HTML: Preset-runner row; hidden until the user switches from single-regex mode. -->
          <div id="rs-preset-inputs-row" class="rs-row" style="display: none;">
            <!-- HTML/CSS: Dropdown for selecting which saved pipeline to run against the current fields. -->
            <select id="rs-runner-preset-select" class="rs-input" style="flex: 1;">
              <option value="">-- Choose Pipeline Preset to Run --</option>
            </select>
            <!-- HTML: Jumps to the pipeline builder for editing the selected preset. -->
            <button class="rs-btn" id="rs-goto-pipeline-btn" title="Open in Pipeline Editor">Edit Preset</button>
          </div>

          <!-- HTML: Bottom execution/navigation toolbar. -->
          <div class="rs-row" style="justify-content: flex-end;">
            <div id="rs-single-match-nav" class="rs-row" style="margin-right: auto;">
              <!-- HTML/CSS: Displays current match position/count. -->
              <span id="rs-match-count" style="font-size: 11px; color: var(--lumiverse-text-dim);">No matches</span>
              <!-- HTML: Moves to the previous regex match. -->
              <button class="rs-btn" id="rs-prev-match-btn" title="Previous Match" disabled>◀</button>
              <!-- HTML: Moves to the next regex match. -->
              <button class="rs-btn" id="rs-next-match-btn" title="Next Match" disabled>▶</button>
              <!-- HTML: Replaces only the currently selected match. -->
              <button class="rs-btn" id="rs-replace-one-btn" title="Replace Current Match" disabled>Replace</button>
            </div>
            
            <!-- HTML: Applies the replacement to every matching occurrence across all active fields, or runs a pipeline in preset mode. -->
            <button class="rs-btn rs-btn-primary" id="rs-replace-all-btn">Replace All</button>
            <!-- HTML/CSS: Toggles the before/after diff confirmation step. -->
            <label class="rs-chip active" id="rs-toggle-diff" title="Show diff preview before applying Replace All" style="margin-left: 4px;">Diff Preview</label>
          </div>
        </div>

        <!-- HTML: Scrollable container holding one editable text panel per active character/lorebook field. -->
        <div id="rs-fields-container" class="rs-fields-list">
          <!-- HTML/CSS: Empty-state message shown before a source/field selection is made. -->
          <div style="text-align: center; color: var(--lumiverse-text-dim); padding: 24px;">
            Choose a Character Card or Lorebook above to display editable fields.
          </div>
        </div>
      </div>

      <!-- HTML: TAB VIEW 2 — pipeline/preset builder mount point. PipelineManagerUI renders into this element. -->
      <div id="rs-view-pipelines" style="display: none;"></div>
    </div>
  `

  // ── Element Handles ──
  const tabEditor = tab.root.querySelector('#rs-tab-editor') as HTMLElement
  const tabPipelines = tab.root.querySelector('#rs-tab-pipelines') as HTMLElement
  const viewEditor = tab.root.querySelector('#rs-view-editor') as HTMLElement
  const viewPipelines = tab.root.querySelector('#rs-view-pipelines') as HTMLElement

  const modeCharBtn = tab.root.querySelector('#rs-mode-char') as HTMLButtonElement
  const modeBatchBtn = tab.root.querySelector('#rs-mode-batch') as HTMLButtonElement
  const modeLoreBtn = tab.root.querySelector('#rs-mode-lore') as HTMLButtonElement
  const modeCustomBtn = tab.root.querySelector('#rs-mode-custom') as HTMLButtonElement
  const tagFiltersSection = tab.root.querySelector('#rs-tag-filters-section') as HTMLElement
  const tagControlsSlot = tab.root.querySelector('#rs-tag-controls-slot') as HTMLElement
  const selectorSection = tab.root.querySelector('#rs-selector-section') as HTMLElement
  const selectSlot = tab.root.querySelector('#rs-select-slot') as HTMLElement
  const selectAllBtn = tab.root.querySelector('#rs-select-all-btn') as HTMLButtonElement
  const deselectAllBtn = tab.root.querySelector('#rs-deselect-all-btn') as HTMLButtonElement
  const refreshBtn = tab.root.querySelector('#rs-refresh-btn') as HTMLButtonElement
  const fieldsFilterCard = tab.root.querySelector('#rs-fields-filter') as HTMLElement
  const chipsContainer = tab.root.querySelector('#rs-chips-container') as HTMLElement

  const toggleModeBtn = tab.root.querySelector('#rs-toggle-mode-btn') as HTMLButtonElement
  const singleFlagsRow = tab.root.querySelector('#rs-single-regex-flags') as HTMLElement
  const singleInputsRow = tab.root.querySelector('#rs-single-inputs-row') as HTMLElement
  const singleMatchNav = tab.root.querySelector('#rs-single-match-nav') as HTMLElement
  const presetInputsRow = tab.root.querySelector('#rs-preset-inputs-row') as HTMLElement
  const runnerPresetSelect = tab.root.querySelector('#rs-runner-preset-select') as HTMLSelectElement
  const gotoPipelineBtn = tab.root.querySelector('#rs-goto-pipeline-btn') as HTMLButtonElement

  const regexFindInput = tab.root.querySelector('#rs-regex-find') as HTMLInputElement
  const regexReplaceInput = tab.root.querySelector('#rs-regex-replace') as HTMLInputElement
  const regexToggleBtn = tab.root.querySelector('#rs-toggle-regex') as HTMLElement
  const diffToggleBtn = tab.root.querySelector('#rs-toggle-diff') as HTMLElement
  const flagGEl = tab.root.querySelector('#rs-flag-g') as HTMLElement
  const flagMEl = tab.root.querySelector('#rs-flag-m') as HTMLElement
  const flagSEl = tab.root.querySelector('#rs-flag-s') as HTMLElement
  const colorPicker = tab.root.querySelector('#rs-color-picker') as HTMLInputElement
  const matchCountSpan = tab.root.querySelector('#rs-match-count') as HTMLElement
  const prevMatchBtn = tab.root.querySelector('#rs-prev-match-btn') as HTMLButtonElement
  const nextMatchBtn = tab.root.querySelector('#rs-next-match-btn') as HTMLButtonElement
  const replaceOneBtn = tab.root.querySelector('#rs-replace-one-btn') as HTMLButtonElement
  const replaceAllBtn = tab.root.querySelector('#rs-replace-all-btn') as HTMLButtonElement
  const fieldsContainer = tab.root.querySelector('#rs-fields-container') as HTMLElement

  const undoBtn = tab.root.querySelector('#rs-undo-btn') as HTMLButtonElement
  const redoBtn = tab.root.querySelector('#rs-redo-btn') as HTMLButtonElement
  const toggleFieldsBtn = tab.root.querySelector('#rs-toggle-fields-btn') as HTMLButtonElement
  const copyBtn = tab.root.querySelector('#rs-copy-btn') as HTMLButtonElement
  const resetBtn = tab.root.querySelector('#rs-reset-btn') as HTMLButtonElement
  const saveBtn = tab.root.querySelector('#rs-save-btn') as HTMLButtonElement

  // Initialize Pipeline UI
  pipelineUI = new PipelineManagerUI(ctx, viewPipelines)

  // ── Switch Main Drawer Tabs ──
  function switchTabView(view: TabView) {
    activeTabView = view
    tabEditor.classList.toggle('active', view === 'editor')
    tabPipelines.classList.toggle('active', view === 'pipelines')
    viewEditor.style.display = view === 'editor' ? 'flex' : 'none'
    viewPipelines.style.display = view === 'pipelines' ? 'flex' : 'none'
  }

  tabEditor.onclick = () => switchTabView('editor')
  tabPipelines.onclick = () => switchTabView('pipelines')

  gotoPipelineBtn.onclick = () => {
    if (selectedPresetId) pipelineUI?.selectPresetById(selectedPresetId)
    switchTabView('pipelines')
  }

  // ── Switch Single Regex vs Preset Runner ──
  function setPresetRunMode(enabled: boolean) {
    isPresetRunMode = enabled
    toggleModeBtn.textContent = isPresetRunMode ? '⇄ Switch to Single Regex' : '⇄ Switch to Presets'
    singleFlagsRow.style.visibility = isPresetRunMode ? 'hidden' : 'visible'
    singleInputsRow.style.display = isPresetRunMode ? 'none' : 'flex'
    singleMatchNav.style.display = isPresetRunMode ? 'none' : 'flex'
    presetInputsRow.style.display = isPresetRunMode ? 'flex' : 'none'
    replaceAllBtn.textContent = isPresetRunMode ? 'Run Pipeline' : 'Replace All'
    if (!isPresetRunMode) scanMatches({ shouldFocus: false })
  }

  toggleModeBtn.onclick = () => setPresetRunMode(!isPresetRunMode)

  runnerPresetSelect.onchange = () => {
    selectedPresetId = runnerPresetSelect.value
  }

  function updateRunnerPresetDropdown() {
    runnerPresetSelect.innerHTML = '<option value="">-- Choose Pipeline Preset to Run --</option>'
    presets.forEach((p) => {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = `${p.name} (${p.steps.length} steps)`
      runnerPresetSelect.appendChild(opt)
    })
    if (selectedPresetId) runnerPresetSelect.value = selectedPresetId
  }

  // ── Undo / Redo History Stack ──
  function cloneFields(arr: FieldItem[]): FieldItem[] {
    return arr.map((f) => ({ ...f }))
  }

  function pushHistory(newFields: FieldItem[]) {
    historyStack = historyStack.slice(0, historyIndex + 1)
    historyStack.push(cloneFields(newFields))
    if (historyStack.length > MAX_HISTORY) {
      historyStack.shift()
    } else {
      historyIndex++
    }
    updateHistoryButtons()
  }

  function updateHistoryButtons() {
    undoBtn.disabled = historyIndex <= 0
    redoBtn.disabled = historyIndex >= historyStack.length - 1
  }

  function undo() {
    if (historyIndex > 0) {
      historyIndex--
      fields = cloneFields(historyStack[historyIndex])
      updateDomTextareasFromState()
      updateHistoryButtons()
      scanMatches({ shouldFocus: false })
    }
  }

  function redo() {
    if (historyIndex < historyStack.length - 1) {
      historyIndex++
      fields = cloneFields(historyStack[historyIndex])
      updateDomTextareasFromState()
      updateHistoryButtons()
      scanMatches({ shouldFocus: false })
    }
  }

  function resetHistory(initialFields: FieldItem[]) {
    historyStack = [cloneFields(initialFields)]
    historyIndex = 0
    updateHistoryButtons()
  }

  // ── Highlight Color ──
  function setHighlightColor(hexColor: string) {
    tab.root.style.setProperty('--rs-highlight-color', `${hexColor}77`)
  }
  colorPicker.oninput = () => setHighlightColor(colorPicker.value)
  setHighlightColor(colorPicker.value)

  // ── Mount Tag Filter Controls ──
  tagFilterComp = mountTagFilterControls(ctx, tagControlsSlot, () => {
    updateSelectOptions()
  })

  // ── Mount Unified Select Picker ──
  function mountCurrentSelect() {
    singleSelectComp?.destroy()
    multiSelectComp?.destroy()
    singleSelectComp = null
    multiSelectComp = null
    selectSlot.replaceChildren()

    if (currentSourceMode === 'character_batch') {
      multiSelectComp = ctx.components.mountMultiSelect(selectSlot, {
        value: selectedBatchIds,
        placeholder: 'Search and choose cards for Batch...',
        searchPlaceholder: 'Search characters...',
        searchThreshold: 1,
        options: [],
        onChange: (ids) => {
          selectedBatchIds = ids || []
          if (selectedBatchIds.length > 0) {
            ctx.sendToBackend({ type: 'get_batch_characters', characterIds: selectedBatchIds })
          } else {
            selectedBatchChars = []
            fields = []
            renderFieldsDOM()
          }
        },
      })
    } else {
      singleSelectComp = ctx.components.mountSelect(selectSlot, {
        value: selectedItemId,
        placeholder: currentSourceMode === 'character' ? 'Choose Character...' : 'Choose Lorebook...',
        searchPlaceholder: 'Search by name...',
        searchThreshold: 1,
        options: [],
        onChange: (id) => {
          selectedItemId = id || ''
          if (!selectedItemId) return
          if (currentSourceMode === 'character') {
            ctx.sendToBackend({ type: 'get_character', characterId: selectedItemId })
          } else if (currentSourceMode === 'lorebook') {
            ctx.sendToBackend({ type: 'get_world_book', worldBookId: selectedItemId })
          }
        },
      })
    }
    updateSelectOptions()
  }

  // ── Field Filter Chips ──
  // HTML: One field-selection chip is generated for every entry in CHAR_FIELDS.
  // CSS: .rs-chip/.rs-chip.active provide the pill appearance and selected state.
  CHAR_FIELDS.forEach((f) => {
    const chip = document.createElement('span')
    chip.className = `rs-chip ${enabledFields.has(f.key) ? 'active' : ''}`
    chip.textContent = f.label
    chip.onclick = () => {
      if (enabledFields.has(f.key)) {
        enabledFields.delete(f.key)
        chip.classList.remove('active')
      } else {
        enabledFields.add(f.key)
        chip.classList.add('active')
      }
      if (currentSourceMode === 'character' && selectedChar) buildCharacterFields()
      else if (currentSourceMode === 'character_batch' && selectedBatchChars.length > 0) buildBatchFields()
    }
    chipsContainer.appendChild(chip)
  })

  // ── Diff Preview Toggle ──
  diffToggleBtn.onclick = () => {
    previewDiffEnabled = !previewDiffEnabled
    diffToggleBtn.classList.toggle('active', previewDiffEnabled)
  }

  // ── Single Regex Toggle & Flags ──
  function updateRegexModeUI() {
    regexToggleBtn.classList.toggle('active', useRegex)
    regexFindInput.placeholder = useRegex ? 'Find Regex (e.g. \\*[\\s\\S]*?\\*)' : 'Find plain text...'
    regexReplaceInput.placeholder = useRegex ? 'Replace (e.g. $1 or empty)' : 'Replace text...'
    flagGEl.classList.toggle('disabled', !useRegex)
    flagMEl.classList.toggle('disabled', !useRegex)
    flagSEl.classList.toggle('disabled', !useRegex)
    scanMatches({ shouldFocus: false })
  }

  regexToggleBtn.onclick = () => {
    useRegex = !useRegex
    updateRegexModeUI()
  }

  ;(['g', 'i', 'm', 's'] as const).forEach((f) => {
    const el = tab.root.querySelector(`#rs-flag-${f}`) as HTMLElement
    el.onclick = () => {
      if (!useRegex && (f === 'm' || f === 's' || f === 'g')) return
      flags[f] = !flags[f]
      el.classList.toggle('active', flags[f])
      scanMatches({ shouldFocus: false })
    }
  })

  function updateAllFieldsOpenState() {
    fieldsContainer.querySelectorAll('.rs-field-textarea').forEach((element) => {
      const textarea = element as HTMLTextAreaElement
      textarea.style.display = fieldsExpanded ? 'block' : 'none'

      const box = textarea.parentElement
      const header = box?.querySelector('.rs-field-header') as HTMLElement | null
      const labelSpan = header?.querySelector('span') as HTMLElement | null

      if (header) {
        header.style.borderBottom = fieldsExpanded
          ? '1px solid var(--lumiverse-border)'
          : 'none'
      }

      if (labelSpan) {
        const field = fields.find((f) => f.id === textarea.dataset.fieldId)
        if (field) {
          labelSpan.textContent = `${fieldsExpanded ? '▼' : '▶'} ${field.label}`
        }
      }
    })

    toggleFieldsBtn.textContent = fieldsExpanded ? 'Close All' : 'Open All'
  }

  // ── DOM Multi-Field Rendering ──
  function renderFieldsDOM() {
    fieldsContainer.innerHTML = ''

    if (fields.length === 0) {
      fieldsContainer.innerHTML = `
        <div style="text-align: center; color: var(--lumiverse-text-dim); padding: 24px;">
          ${currentSourceMode === 'custom' ? 'Type in the box below.' : 'No active cards or fields selected.'}
        </div>
      `
      return
    }

    fields.forEach((field) => {
      // HTML: One editable field panel generated from the current source data.
      // CSS: .rs-field-box supplies the bordered card/panel appearance.
      const box = document.createElement('div')
      box.className = 'rs-field-box'

      // HTML: Field header containing the human-readable field name and optional metadata.
      // CSS: .rs-field-header creates the compact header strip and .rs-field-sub styles its secondary text.
      const header = document.createElement('div')
      header.className = 'rs-field-header'
      header.innerHTML = `
        <span>${fieldsExpanded ? '▼' : '▶'} ${field.label}</span>
        ${field.sublabel ? `<span class="rs-field-sub">${field.sublabel}</span>` : ''}
      `

      // HTML: Editable text area containing the actual character/lorebook/custom text value.
      // CSS: .rs-field-textarea controls typography, dimensions, selection color, and resize behavior.
      const textarea = document.createElement('textarea')
      textarea.className = 'rs-field-textarea'
      textarea.value = field.value
      textarea.dataset.fieldId = field.id
      textarea.placeholder = `Enter content here...`
      textarea.style.display = fieldsExpanded ? 'block' : 'none'

      textarea.oninput = () => {
        field.value = textarea.value
        scanMatches({ shouldFocus: false })

        if (typingTimer) clearTimeout(typingTimer)
        typingTimer = setTimeout(() => {
          pushHistory(fields)
        }, 600)
      }

      header.addEventListener('click', () => {
        const isOpen = textarea.style.display !== 'none'
        const nextOpen = !isOpen

        textarea.style.display = nextOpen ? 'block' : 'none'

        const labelSpan = header.querySelector('span')
        if (labelSpan) {
          labelSpan.textContent = `${nextOpen ? '▼' : '▶'} ${field.label}`
        }

        header.style.borderBottom = nextOpen
          ? '1px solid var(--lumiverse-border)'
          : 'none'
      })

      box.appendChild(header)
      box.appendChild(textarea)
      fieldsContainer.appendChild(box)
    })

    scanMatches({ shouldFocus: false })
  }

  function updateDomTextareasFromState() {
    fields.forEach((field) => {
      const ta = fieldsContainer.querySelector(`[data-field-id="${field.id}"]`) as HTMLTextAreaElement | null
      if (ta && ta.value !== field.value) {
        ta.value = field.value
      }
    })
  }

  // ── Field Generators ──
  function buildCharacterFields() {
    if (!selectedChar) return
    const newFields: FieldItem[] = []

    for (const f of CHAR_FIELDS) {
      if (!enabledFields.has(f.key)) continue

      if (f.key === 'alternate_greetings') {
        const altGreetings: string[] = Array.isArray(selectedChar.alternate_greetings)
          ? selectedChar.alternate_greetings
          : []
        altGreetings.forEach((greeting, idx) => {
          newFields.push({
            id: `alt_greeting_${idx}`,
            key: 'alternate_greetings',
            label: `Alternate Greeting ${idx + 1}`,
            value: (greeting || '').replace(/\r\n/g, '\n'),
          })
        })
      } else {
        newFields.push({
          id: f.key,
          key: f.key,
          label: f.label,
          value: (selectedChar[f.key] || '').replace(/\r\n/g, '\n'),
        })
      }
    }

    fields = newFields
    renderFieldsDOM()
    resetHistory(fields)
  }

  function buildBatchFields() {
    fields = buildBatchCharacterFields(selectedBatchChars, enabledFields, CHAR_FIELDS)
    renderFieldsDOM()
    resetHistory(fields)
  }

  function buildWorldBookFields() {
    fields = selectedWorldBookEntries.map((entry, idx) => ({
      id: entry.id,
      key: 'entry',
      label: entry.comment || `Entry ${idx + 1}`,
      sublabel: `ID: ${entry.id}`,
      value: (entry.content || '').replace(/\r\n/g, '\n'),
    }))

    renderFieldsDOM()
    resetHistory(fields)
  }

  function buildCustomField() {
    fields = [
      {
        id: 'custom_scratchpad',
        key: 'custom',
        label: 'Custom Text Editor',
        value: fields[0]?.value || '',
      },
    ]
    renderFieldsDOM()
    resetHistory(fields)
  }

  // ── Single Regex Matching Engine ──
  function getActiveRegExp(): RegExp | null {
    const pattern = regexFindInput.value
    if (!pattern) return null
    try {
      if (!useRegex) {
        return new RegExp(escapeRegExp(pattern), flags.i ? 'gi' : 'g')
      }
      let flagStr = ''
      if (flags.g) flagStr += 'g'
      if (flags.i) flagStr += 'i'
      if (flags.m) flagStr += 'm'
      if (flags.s) flagStr += 's'
      return new RegExp(pattern, flagStr)
    } catch {
      return null
    }
  }

  function scanMatches(opts: { shouldFocus?: boolean; preserveIndex?: boolean } = {}) {
    if (isPresetRunMode) return
    const rx = getActiveRegExp()
    currentMatches = []

    if (!rx || fields.length === 0) {
      currentMatchIndex = -1
      updateMatchUI(opts.shouldFocus ?? false)
      return
    }

    const execRx = rx.global ? rx : new RegExp(rx.source, rx.flags + 'g')

    fields.forEach((field, fieldIndex) => {
      let match: RegExpExecArray | null
      execRx.lastIndex = 0

      while ((match = execRx.exec(field.value)) !== null) {
        currentMatches.push({
          fieldId: field.id,
          fieldIndex,
          startIndex: match.index,
          length: match[0].length,
          text: match[0],
        })
        if (match.index === execRx.lastIndex) {
          execRx.lastIndex++
        }
      }
    })

    if (!opts.preserveIndex || currentMatchIndex >= currentMatches.length) {
      currentMatchIndex = currentMatches.length > 0 ? 0 : -1
    }

    updateMatchUI(opts.shouldFocus ?? false)
  }

  function updateMatchUI(shouldFocus: boolean) {
    const total = currentMatches.length
    if (total === 0) {
      matchCountSpan.textContent = 'No matches'
      prevMatchBtn.disabled = true
      nextMatchBtn.disabled = true
      replaceOneBtn.disabled = true
    } else {
      matchCountSpan.textContent = `${currentMatchIndex + 1} of ${total}`
      prevMatchBtn.disabled = false
      nextMatchBtn.disabled = false
      replaceOneBtn.disabled = false
      if (shouldFocus) {
        highlightCurrentMatch()
      }
    }
  }

  function highlightCurrentMatch() {
    if (currentMatchIndex < 0 || currentMatchIndex >= currentMatches.length) return

    const match = currentMatches[currentMatchIndex]

    // If all fields are normally open, leave them that way.
    // Otherwise, automatically open the field containing the match.
    if (!fieldsExpanded) {
      if (autoOpenedFieldId && autoOpenedFieldId !== match.fieldId) {
        const previousTextarea = fieldsContainer.querySelector(
          `[data-field-id="${autoOpenedFieldId}"]`
        ) as HTMLTextAreaElement | null

        if (previousTextarea) {
          previousTextarea.style.display = 'none'

          const previousHeader = previousTextarea.parentElement?.querySelector(
            '.rs-field-header'
          ) as HTMLElement | null

          const previousLabel = previousHeader?.querySelector('span') as HTMLElement | null

          if (previousLabel) {
            const previousField = fields.find((f) => f.id === autoOpenedFieldId)
            if (previousField) {
              previousLabel.textContent = `▶ ${previousField.label}`
            }
          }

          if (previousHeader) {
            previousHeader.style.borderBottom = 'none'
          }
        }

        autoOpenedFieldId = null
      }

      const targetTextarea = fieldsContainer.querySelector(
        `[data-field-id="${match.fieldId}"]`
      ) as HTMLTextAreaElement | null

      if (targetTextarea && targetTextarea.style.display === 'none') {
        targetTextarea.style.display = 'block'

        const targetHeader = targetTextarea.parentElement?.querySelector(
          '.rs-field-header'
        ) as HTMLElement | null

        const targetLabel = targetHeader?.querySelector('span') as HTMLElement | null

        if (targetLabel) {
          const targetField = fields.find((f) => f.id === match.fieldId)
          if (targetField) {
            targetLabel.textContent = `▼ ${targetField.label}`
          }
        }

        if (targetHeader) {
          targetHeader.style.borderBottom = '1px solid var(--lumiverse-border)'
        }

        autoOpenedFieldId = match.fieldId
      }
    }

    const textarea = fieldsContainer.querySelector(
      `[data-field-id="${match.fieldId}"]`
    ) as HTMLTextAreaElement | null

    if (!textarea) return

    // Bring the field itself into the visible field-scroll area first.
    textarea.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })

    textarea.focus()
    textarea.setSelectionRange(
      match.startIndex,
      match.startIndex + match.length
    )

    // Browsers do not consistently scroll a textarea's internal content when
    // a selection is changed programmatically. Build a temporary, invisible
    // text mirror with the same wrapping/font metrics so we can determine the
    // vertical position of the selected match and set scrollTop explicitly.
    const mirror = document.createElement('div')
    const marker = document.createElement('span')
    const style = window.getComputedStyle(textarea)

    mirror.style.cssText = `
      position: fixed;
      left: -100000px;
      top: 0;
      width: ${textarea.clientWidth}px;
      box-sizing: border-box;
      padding: ${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft};
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      font-weight: ${style.fontWeight};
      font-style: ${style.fontStyle};
      line-height: ${style.lineHeight};
      letter-spacing: ${style.letterSpacing};
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: ${style.wordBreak};
      visibility: hidden;
      pointer-events: none;
    `

    mirror.appendChild(document.createTextNode(
      textarea.value.slice(0, match.startIndex)
    ))
    marker.textContent = textarea.value.slice(
      match.startIndex,
      match.startIndex + match.length
    ) || ' '
    mirror.appendChild(marker)
    document.body.appendChild(mirror)

    const targetTop = marker.offsetTop
    const targetCenter = targetTop + marker.offsetHeight / 2
    const desiredScrollTop = Math.max(
      0,
      targetCenter - textarea.clientHeight / 2
    )

    textarea.scrollTop = Math.min(
      desiredScrollTop,
      Math.max(0, textarea.scrollHeight - textarea.clientHeight)
    )

    mirror.remove()
  }

  function nextMatch() {
    if (currentMatches.length === 0) return
    currentMatchIndex = (currentMatchIndex + 1) % currentMatches.length
    updateMatchUI(true)
  }

  function prevMatch() {
    if (currentMatches.length === 0) return
    currentMatchIndex = (currentMatchIndex - 1 + currentMatches.length) % currentMatches.length
    updateMatchUI(true)
  }

  function replaceSingleMatch() {
    if (currentMatchIndex < 0 || currentMatchIndex >= currentMatches.length) return
    const match = currentMatches[currentMatchIndex]
    const field = fields[match.fieldIndex]
    const rx = getActiveRegExp()
    if (!rx || !field) return

    const replacePattern = regexReplaceInput.value
    const matchedSubstring = field.value.slice(match.startIndex, match.startIndex + match.length)

    const replaced = useRegex
      ? matchedSubstring.replace(rx, replacePattern)
      : replacePattern

    field.value = field.value.slice(0, match.startIndex) + replaced + field.value.slice(match.startIndex + match.length)

    updateDomTextareasFromState()
    pushHistory(fields)
    scanMatches({ shouldFocus: true, preserveIndex: true })
  }

  function applyReplaceAll(diffItems: FieldDiffItem[]) {
    diffItems.forEach((diff) => {
      const field = fields.find((f) => f.id === diff.fieldId)
      if (field) field.value = diff.newValue
    })

    updateDomTextareasFromState()
    pushHistory(fields)
    scanMatches({ shouldFocus: false })
  }

  function handleReplaceAllClick() {
    if (fields.length === 0) return

    let diffItems: FieldDiffItem[] = []

    if (isPresetRunMode) {
      const preset = presets.find((p) => p.id === runnerPresetSelect.value)
      if (!preset || preset.steps.length === 0) return

      diffItems = fields.map((field) => ({
        fieldId: field.id,
        label: field.label,
        sublabel: field.sublabel,
        oldValue: field.value,
        newValue: runPipelineOnText(field.value, preset.steps),
      }))
    } else {
      const rx = getActiveRegExp()
      if (!rx) return
      const replaceStr = regexReplaceInput.value

      diffItems = fields.map((field) => {
        const newValue = useRegex
          ? field.value.replace(rx, replaceStr)
          : field.value.replace(rx, () => replaceStr)

        return {
          fieldId: field.id,
          label: field.label,
          sublabel: field.sublabel,
          oldValue: field.value,
          newValue,
        }
      })
    }

    if (previewDiffEnabled) {
      const opened = showDiffPreviewModal(
        ctx,
        diffItems,
        (approvedFields) => applyReplaceAll(approvedFields)
      )
      if (!opened) scanMatches({ shouldFocus: false })
    } else {
      applyReplaceAll(diffItems)
    }
  }

  // ── Source Mode Switching ──
  function setSourceMode(mode: SourceMode) {
    currentSourceMode = mode
    modeCharBtn.className = `rs-btn ${mode === 'character' ? 'rs-btn-primary' : ''}`
    modeBatchBtn.className = `rs-btn ${mode === 'character_batch' ? 'rs-btn-primary' : ''}`
    modeLoreBtn.className = `rs-btn ${mode === 'lorebook' ? 'rs-btn-primary' : ''}`
    modeCustomBtn.className = `rs-btn ${mode === 'custom' ? 'rs-btn-primary' : ''}`

    tagFiltersSection.style.display = (mode === 'character' || mode === 'character_batch') ? 'flex' : 'none'
    selectAllBtn.style.display = mode === 'character_batch' ? 'inline-flex' : 'none'
    deselectAllBtn.style.display = mode === 'character_batch' ? 'inline-flex' : 'none'
    fieldsFilterCard.style.display = (mode === 'character' || mode === 'character_batch') ? 'flex' : 'none'

    if (mode === 'custom') {
      selectorSection.style.display = 'none'
      saveBtn.style.display = 'none'
      buildCustomField()
    } else {
      selectorSection.style.display = 'flex'
      saveBtn.style.display = 'inline-block'
      selectedItemId = ''
      selectedBatchIds = []
      selectedBatchChars = []
      fields = []
      renderFieldsDOM()
      mountCurrentSelect()
      fetchList()
    }
  }

  function getFilteredCharacters(): CharacterItemWithTags[] {
    if (!tagFilterComp) return rawCharacters
    return filterCharactersByTags(
      rawCharacters,
      tagFilterComp.state.includeTags,
      tagFilterComp.state.excludeTags
    )
  }

  function updateSelectOptions() {
    const filteredChars = getFilteredCharacters()

    if (currentSourceMode === 'character') {
      singleSelectComp?.update({
        value: selectedItemId,
        placeholder: `Choose from ${filteredChars.length} characters...`,
        searchPlaceholder: 'Search character name...',
        options: filteredChars.map((c) => ({ value: c.id, label: c.name })),
      })
    } else if (currentSourceMode === 'character_batch') {
      multiSelectComp?.update({
        value: selectedBatchIds,
        placeholder: `Select cards (${selectedBatchIds.length}/${filteredChars.length} selected)...`,
        searchPlaceholder: 'Search characters for batch...',
        options: filteredChars.map((c) => ({ value: c.id, label: c.name })),
      })
    } else if (currentSourceMode === 'lorebook') {
      singleSelectComp?.update({
        value: selectedItemId,
        placeholder: `Choose from ${worldBooks.length} lorebooks...`,
        searchPlaceholder: 'Search lorebook name...',
        options: worldBooks.map((b) => ({ value: b.id, label: b.name })),
      })
    }
  }

  function fetchList() {
    if (currentSourceMode === 'character' || currentSourceMode === 'character_batch') {
      ctx.sendToBackend({ type: 'list_characters' })
    } else if (currentSourceMode === 'lorebook') {
      ctx.sendToBackend({ type: 'list_world_books' })
    }
  }

  // ── Select All / Deselect All (Batch Mode) ──
  selectAllBtn.onclick = () => {
    const filteredChars = getFilteredCharacters()
    const allIds = filteredChars.map((c) => c.id)
    selectedBatchIds = allIds
    multiSelectComp?.update({ value: allIds })
    if (allIds.length > 0) {
      ctx.sendToBackend({ type: 'get_batch_characters', characterIds: allIds })
    }
  }

  deselectAllBtn.onclick = () => {
    selectedBatchIds = []
    multiSelectComp?.update({ value: [] })
    selectedBatchChars = []
    fields = []
    renderFieldsDOM()
  }

  // ── Event Handlers ──
  modeCharBtn.onclick = () => setSourceMode('character')
  modeBatchBtn.onclick = () => setSourceMode('character_batch')
  modeLoreBtn.onclick = () => setSourceMode('lorebook')
  modeCustomBtn.onclick = () => setSourceMode('custom')
  refreshBtn.onclick = () => fetchList()

  regexFindInput.oninput = () => scanMatches({ shouldFocus: false })

  regexFindInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) prevMatch()
      else nextMatch()
    }
  }

  undoBtn.onclick = () => undo()
  redoBtn.onclick = () => redo()

  toggleFieldsBtn.onclick = () => {
    fieldsExpanded = !fieldsExpanded
    localStorage.setItem('regex-studio-fields-expanded', String(fieldsExpanded))
    autoOpenedFieldId = null
    updateAllFieldsOpenState()
  }
  
  nextMatchBtn.onclick = () => nextMatch()
  prevMatchBtn.onclick = () => prevMatch()
  replaceOneBtn.onclick = () => replaceSingleMatch()
  replaceAllBtn.onclick = () => handleReplaceAllClick()

  resetBtn.onclick = () => {
    if (currentSourceMode === 'character' && selectedChar) buildCharacterFields()
    else if (currentSourceMode === 'character_batch' && selectedBatchChars.length > 0) buildBatchFields()
    else if (currentSourceMode === 'lorebook') buildWorldBookFields()
    else buildCustomField()
  }

  copyBtn.onclick = () => {
    const combined = fields.map((f) => `[${f.label}]\n${f.value}`).join('\n\n')
    navigator.clipboard.writeText(combined)
  }

  saveBtn.onclick = () => {
    if (currentSourceMode === 'character' && selectedChar) {
      const patch: Record<string, any> = {}
      const altGreetings: string[] = []

      fields.forEach((f) => {
        if (f.key === 'alternate_greetings') {
          altGreetings.push(f.value)
        } else {
          patch[f.key] = f.value
        }
      })

      if (enabledFields.has('alternate_greetings')) {
        patch.alternate_greetings = altGreetings
      }

      ctx.sendToBackend({
        type: 'save_character',
        characterId: selectedChar.id,
        name: selectedChar.name,
        patch,
      })
    } else if (currentSourceMode === 'character_batch' && selectedBatchChars.length > 0) {
      const updates = assembleBatchPatches(fields as BatchFieldItem[], enabledFields)
      ctx.sendToBackend({
        type: 'save_batch_characters',
        updates,
      })
    } else if (currentSourceMode === 'lorebook' && selectedItemId) {
      const updates = fields.map((f) => ({ id: f.id, content: f.value }))
      ctx.sendToBackend({
        type: 'save_world_book_entries',
        worldBookId: selectedItemId,
        updates,
      })
    }
  }

  // ── Backend Message Handling ──
  const unsubMsg = ctx.onBackendMessage((payload: any) => {
    switch (payload.type) {
      case 'presets_loaded': {
        presets = payload.presets || []
        pipelineUI?.setPresets(presets)
        updateRunnerPresetDropdown()
        break
      }

      case 'characters_list': {
        rawCharacters = payload.characters || []
        tagFilterComp?.setCharacters(rawCharacters)
        updateSelectOptions()
        break
      }

      case 'world_books_list': {
        worldBooks = payload.worldBooks || []
        updateSelectOptions()
        break
      }

      case 'character_data': {
        selectedChar = payload.character
        buildCharacterFields()
        break
      }

      case 'batch_characters_data': {
        selectedBatchChars = payload.characters || []
        buildBatchFields()
        break
      }

      case 'world_book_data': {
        selectedWorldBookEntries = payload.entries || []
        buildWorldBookFields()
        break
      }

      case 'save_success': {
        if (payload.entityType === 'character' && selectedChar) {
          ctx.sendToBackend({ type: 'get_character', characterId: selectedChar.id })
        } else if (payload.entityType === 'character_batch' && selectedBatchIds.length > 0) {
          ctx.sendToBackend({ type: 'get_batch_characters', characterIds: selectedBatchIds })
        } else if (payload.entityType === 'world_book' && selectedItemId) {
          ctx.sendToBackend({ type: 'get_world_book', worldBookId: selectedItemId })
        }
        break
      }
    }
  })

  // Initial load
  mountCurrentSelect()
  updateRegexModeUI()
  ctx.sendToBackend({ type: 'load_presets' })
  fetchList()

  // ── Teardown ──
  return () => {
    if (typingTimer) clearTimeout(typingTimer)
    removeStyle()
    unsubMsg()
    singleSelectComp?.destroy()
    multiSelectComp?.destroy()
    tagFilterComp?.destroy()
    tab.destroy()
  }
}
