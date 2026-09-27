import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { RegexPreset, PipelineStep } from './pipeline-types'

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function runPipelineOnText(text: string, steps: PipelineStep[]): string {
  let result = text
  for (const step of steps) {
    if (!step.find) continue
    try {
      let rx: RegExp
      if (!step.useRegex) {
        rx = new RegExp(escapeRegExp(step.find), step.flags.i ? 'gi' : 'g')
      } else {
        let flagStr = ''
        if (step.flags.g) flagStr += 'g'
        if (step.flags.i) flagStr += 'i'
        if (step.flags.m) flagStr += 'm'
        if (step.flags.s) flagStr += 's'
        rx = new RegExp(step.find, flagStr)
      }
      result = step.useRegex
        ? result.replace(rx, step.replace)
        : result.replace(rx, () => step.replace)
    } catch {
      // Ignore invalid regex in single pipeline step
    }
  }
  return result
}

export function createPipelineStep(): PipelineStep {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    find: '',
    replace: '',
    useRegex: true,
    flags: { g: true, i: false, m: true, s: true },
  }
}

export class PipelineManagerUI {
  private ctx: SpindleFrontendContext
  private container: HTMLElement
  private presets: RegexPreset[] = []
  private activePreset: RegexPreset | null = null
  private expandedSteps = new Set<string>()

  constructor(ctx: SpindleFrontendContext, container: HTMLElement) {
    this.ctx = ctx
    this.container = container
    this.renderShell()
  }

  public setPresets(presets: RegexPreset[]) {
    this.presets = presets
    this.updateDropdown()
    if (this.activePreset) {
      const refreshed = presets.find((p) => p.id === this.activePreset!.id)
      if (refreshed) {
        this.activePreset = refreshed
        this.renderSteps()
      }
    }
  }

  public selectPresetById(id: string) {
    const found = this.presets.find((p) => p.id === id)
    if (found) {
      this.activePreset = JSON.parse(JSON.stringify(found))
      const select = this.container.querySelector('#rs-pipe-preset-select') as HTMLSelectElement
      if (select) select.value = id
      this.renderSteps()
    }
  }

  private renderShell() {
    this.container.innerHTML = `
      <!-- HTML: Pipeline editor root; vertical layout that contains the entire preset editor. -->
      <!-- CSS: flex-column stacks the preset controls, metadata, steps, and footer with 10px gaps. -->
      <div style="display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0;">
        <!-- HTML: Top control row containing preset selection/creation on the left and save/delete on the right. -->
        <!-- CSS: rs-row provides horizontal flex layout; space-between separates the two control groups. -->
        <div class="rs-row" style="justify-content: space-between;">
          <!-- HTML: Preset selector group. -->
          <div class="rs-row" style="flex: 1;">
            <!-- HTML: Dropdown for choosing an existing pipeline preset. -->
            <!-- CSS: rs-input gives the shared input appearance; flex:1 lets it consume available width. -->
            <select id="rs-pipe-preset-select" class="rs-input" style="flex: 1;">
              <!-- HTML: Empty/default option shown before a preset is selected. -->
              <option value="">-- Choose Pipeline Preset --</option>
            </select>
            <!-- HTML: Creates a new pipeline preset with one initial regex step. -->
            <button class="rs-btn" id="rs-pipe-new-btn">+ New Preset</button>
          </div>
          <!-- HTML: Preset persistence controls. -->
          <div class="rs-row">
            <!-- HTML: Deletes the currently selected preset; disabled until a preset is active. -->
            <!-- CSS: red text visually marks this as a destructive action. -->
            <button class="rs-btn" id="rs-pipe-del-btn" style="color: #f87171;" disabled>Delete</button>
            <!-- HTML: Saves the currently edited preset to the backend; disabled until a preset is active. -->
            <button class="rs-btn rs-btn-primary" id="rs-pipe-save-btn" disabled>Save Preset</button>
          </div>
        </div>

        <!-- HTML: Preset metadata section containing the editable preset name. -->
        <!-- CSS: hidden by default; becomes a vertical flex container when a preset is selected/created. -->
        <div id="rs-pipe-meta-box" style="display: none; flex-direction: column; gap: 6px;">
          <!-- HTML: Text input for naming the pipeline preset. -->
          <!-- CSS: rs-input supplies the shared input styling; font-weight emphasizes the name. -->
          <input type="text" id="rs-pipe-name-input" class="rs-input" placeholder="Preset Name" style="font-weight: 600;" />
        </div>

        <!-- HTML: Scrollable container where individual regex-step cards are rendered dynamically. -->
        <!-- CSS: vertical flex layout, 10px gaps, 52vh max height, and vertical scrolling. -->
        <div class="rs-row" id="rs-pipe-steps-toolbar" style="display: none; justify-content: flex-end;">
          <button class="rs-btn" id="rs-pipe-expand-all-btn">Expand All</button>
          <button class="rs-btn" id="rs-pipe-collapse-all-btn">Collapse All</button>
        </div>

        <!-- HTML: Scrollable container where individual regex-step cards are rendered dynamically. -->
        <div id="rs-pipe-steps-container" style="display: flex; flex-direction: column; gap: 10px; flex: 1 1 0; min-height: 0; max-height: none; overflow-y: auto; padding-right: 2px;"></div>

        <!-- HTML: Footer containing the add-step action; hidden until a preset is active. -->
        <div id="rs-pipe-footer" style="display: none;" class="rs-row">
          <!-- HTML: Adds another regex/replacement step to the active preset. -->
          <!-- CSS: primary button styling plus full-width layout. -->
          <button class="rs-btn rs-btn-primary" id="rs-pipe-add-step-btn" style="width: 100%;">+ Add Regex Step</button>
        </div>
      </div>
    `

    const select = this.container.querySelector('#rs-pipe-preset-select') as HTMLSelectElement
    const newBtn = this.container.querySelector('#rs-pipe-new-btn') as HTMLButtonElement
    const delBtn = this.container.querySelector('#rs-pipe-del-btn') as HTMLButtonElement
    const saveBtn = this.container.querySelector('#rs-pipe-save-btn') as HTMLButtonElement
    const addStepBtn = this.container.querySelector('#rs-pipe-add-step-btn') as HTMLButtonElement
    const expandAllBtn = this.container.querySelector('#rs-pipe-expand-all-btn') as HTMLButtonElement
    const collapseAllBtn = this.container.querySelector('#rs-pipe-collapse-all-btn') as HTMLButtonElement
    const nameInput = this.container.querySelector('#rs-pipe-name-input') as HTMLInputElement

    select.onchange = () => {
      this.selectPresetById(select.value)
    }

    newBtn.onclick = () => {
      this.activePreset = {
        id: `preset_${Date.now()}`,
        name: `New Pipeline (${this.presets.length + 1})`,
        steps: [createPipelineStep()],
      }
      this.renderSteps()
    }

    nameInput.oninput = () => {
      if (this.activePreset) this.activePreset.name = nameInput.value
    }

    saveBtn.onclick = () => {
      if (!this.activePreset) return
      this.ctx.sendToBackend({ type: 'save_preset', preset: this.activePreset })
    }

    delBtn.onclick = () => {
      if (!this.activePreset) return
      this.ctx.sendToBackend({ type: 'delete_preset', presetId: this.activePreset.id })
      this.activePreset = null
      this.renderSteps()
    }

    addStepBtn.onclick = () => {
      if (!this.activePreset) return
      const step = createPipelineStep()
      this.activePreset.steps.push(step)
      this.expandedSteps.add(step.id)
      this.renderSteps()
    }

    expandAllBtn.onclick = () => {
      if (!this.activePreset) return
      this.activePreset.steps.forEach((step) => this.expandedSteps.add(step.id))
      this.renderSteps()
    }

    collapseAllBtn.onclick = () => {
      this.expandedSteps.clear()
      this.renderSteps()
    }
  }

  private updateDropdown() {
    const select = this.container.querySelector('#rs-pipe-preset-select') as HTMLSelectElement
    if (!select) return
    select.innerHTML = '<option value="">-- Choose Pipeline Preset --</option>'
    this.presets.forEach((p) => {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.name
      select.appendChild(opt)
    })
    if (this.activePreset) select.value = this.activePreset.id
  }

  private renderSteps() {
    const stepsContainer = this.container.querySelector('#rs-pipe-steps-container') as HTMLElement
    const metaBox = this.container.querySelector('#rs-pipe-meta-box') as HTMLElement
    const footer = this.container.querySelector('#rs-pipe-footer') as HTMLElement
    const stepsToolbar = this.container.querySelector('#rs-pipe-steps-toolbar') as HTMLElement
    const delBtn = this.container.querySelector('#rs-pipe-del-btn') as HTMLButtonElement
    const saveBtn = this.container.querySelector('#rs-pipe-save-btn') as HTMLButtonElement
    const nameInput = this.container.querySelector('#rs-pipe-name-input') as HTMLInputElement

    stepsContainer.innerHTML = ''

    if (!this.activePreset) {
      metaBox.style.display = 'none'
      footer.style.display = 'none'
      stepsToolbar.style.display = 'none'
      delBtn.disabled = true
      saveBtn.disabled = true
      stepsContainer.innerHTML = `
        <div style="text-align: center; color: var(--lumiverse-text-dim); padding: 30px 10px;">
          Choose an existing pipeline above or click <b>+ New Preset</b> to create a multi-step regex sequence.
        </div>
      `
      return
    }

    metaBox.style.display = 'flex'
    footer.style.display = 'flex'
    stepsToolbar.style.display = this.activePreset.steps.length > 0 ? 'flex' : 'none'
    delBtn.disabled = false
    saveBtn.disabled = false
    nameInput.value = this.activePreset.name

    this.activePreset.steps.forEach((step, idx) => {
      const isExpanded = this.expandedSteps.has(step.id)
      const stepCard = document.createElement('div')
      stepCard.className = 'rs-card'
      stepCard.style.cssText = 'border: 1px solid var(--lumiverse-border); padding: 0; overflow: hidden;'

      const header = document.createElement('div')
      header.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: var(--lumiverse-fill-subtle);
        cursor: pointer;
        user-select: none;
      `

      const toggle = document.createElement('span')
      toggle.textContent = isExpanded ? '▼' : '▶'
      toggle.style.cssText = 'flex-shrink: 0; color: var(--lumiverse-accent); font-size: 10px;'

      const stepLabel = document.createElement('span')
      stepLabel.textContent = `Step ${idx + 1}`
      stepLabel.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--lumiverse-accent);'

      const errorIcon = document.createElement('span')
      errorIcon.textContent = '⚠'
      errorIcon.style.cssText = 'display: none; flex-shrink: 0; color: #f87171; font-size: 13px; line-height: 1;'
      errorIcon.title = 'Invalid regular expression'

      const spacer = document.createElement('span')
      spacer.style.flex = '1'

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'rs-btn'
      deleteBtn.textContent = '✕'
      deleteBtn.title = 'Remove Step'
      deleteBtn.style.cssText = 'padding: 2px 6px; font-size: 11px; color: #f87171;'

      header.append(toggle, stepLabel, errorIcon, spacer, deleteBtn)

      const content = document.createElement('div')
      content.style.cssText = `
        display: ${isExpanded ? 'flex' : 'none'};
        flex-direction: column;
        gap: 8px;
        padding: 10px;
      `

      content.innerHTML = `
        <div class="rs-row" style="justify-content: space-between;">
          <div class="rs-row">
            <label class="rs-chip ${step.useRegex ? 'active' : ''}" id="rs-step-toggle-regex">.* Regex</label>
            <span style="font-size: 11px; color: var(--lumiverse-text-dim);">Flags:</span>
            <label class="rs-chip ${step.flags.g ? 'active' : ''}" id="rs-step-flag-g">g</label>
            <label class="rs-chip ${step.flags.i ? 'active' : ''}" id="rs-step-flag-i">i</label>
            <label class="rs-chip ${step.flags.m ? 'active' : ''}" id="rs-step-flag-m">m</label>
            <label class="rs-chip ${step.flags.s ? 'active' : ''}" id="rs-step-flag-s">s</label>
          </div>
        </div>
        <div class="rs-row">
          <input type="text" class="rs-input" id="rs-step-find" placeholder="Find pattern..." style="flex: 1;" value="${escapeHtml(step.find)}" />
          <input type="text" class="rs-input" id="rs-step-replace" placeholder="Replace pattern..." style="flex: 1;" value="${escapeHtml(step.replace)}" />
        </div>
      `

      const findInput = content.querySelector('#rs-step-find') as HTMLInputElement
      const replaceInput = content.querySelector('#rs-step-replace') as HTMLInputElement
      const regexToggle = content.querySelector('#rs-step-toggle-regex') as HTMLElement

      const updateValidity = () => {
        if (!step.useRegex || !step.find) {
          errorIcon.style.display = 'none'
          errorIcon.title = 'Invalid regular expression'
          findInput.style.borderColor = ''
          return
        }

        try {
          let flagStr = ''
          if (step.flags.g) flagStr += 'g'
          if (step.flags.i) flagStr += 'i'
          if (step.flags.m) flagStr += 'm'
          if (step.flags.s) flagStr += 's'
          new RegExp(step.find, flagStr)
          errorIcon.style.display = 'none'
          findInput.style.borderColor = ''
        } catch (err: any) {
          errorIcon.style.display = 'inline'
          errorIcon.title = err instanceof Error ? err.message : 'Invalid regular expression'
          findInput.style.borderColor = '#f87171'
        }
      }

      const setExpanded = (expanded: boolean) => {
        if (expanded) this.expandedSteps.add(step.id)
        else this.expandedSteps.delete(step.id)
        toggle.textContent = expanded ? '▼' : '▶'
        content.style.display = expanded ? 'flex' : 'none'
      }

      header.addEventListener('click', (event) => {
        if (event.target === deleteBtn || deleteBtn.contains(event.target as Node)) return
        setExpanded(!this.expandedSteps.has(step.id))
      })

      deleteBtn.onclick = (event) => {
        event.stopPropagation()
        this.expandedSteps.delete(step.id)
        this.activePreset!.steps = this.activePreset!.steps.filter((s) => s.id !== step.id)
        this.renderSteps()
      }

      findInput.oninput = () => {
        step.find = findInput.value
        updateValidity()
      }
      replaceInput.oninput = () => { step.replace = replaceInput.value }

      regexToggle.onclick = (event) => {
        event.stopPropagation()
        step.useRegex = !step.useRegex
        regexToggle.classList.toggle('active', step.useRegex)
        updateValidity()
      }

      ;(['g', 'i', 'm', 's'] as const).forEach((f) => {
        const flagEl = content.querySelector(`#rs-step-flag-${f}`) as HTMLElement
        flagEl.onclick = (event) => {
          event.stopPropagation()
          step.flags[f] = !step.flags[f]
          flagEl.classList.toggle('active', step.flags[f])
          updateValidity()
        }
      })

      updateValidity()
      stepCard.append(header, content)
      stepsContainer.appendChild(stepCard)
    })
  }
}

function escapeHtml(str: string): string {
  return str.replace(/"/g, '&quot;')
}

