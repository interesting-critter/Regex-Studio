import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export interface FieldDiffItem {
  fieldId: string
  label: string
  sublabel?: string
  oldValue: string
  newValue: string
  approved?: boolean
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface DiffResult {
  html: string
  additions: number
  removals: number
}

/**
 * Lightweight word-level token diff engine.
 *
 * Words are kept together, while punctuation/symbols are tokenized one
 * character at a time. This is important for regex edits such as removing
 * `*` next to `{{user}}`: the `*` is then shown as the only removal instead
 * of grouping it together with the neighboring braces.
 */
function computeWordDiff(oldStr: string, newStr: string): DiffResult {
  const tokenize = (s: string) =>
    s.match(/[\w']+|[^\w\s]|\s+/g) || []

  const oldTokens = tokenize(oldStr)
  const newTokens = tokenize(newStr)

  const N = oldTokens.length
  const M = newTokens.length
  const dp: number[][] = Array.from(
    { length: N + 1 },
    () => new Array(M + 1).fill(0)
  )

  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (oldTokens[i] === newTokens[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1]
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  let i = 0
  let j = 0
  let html = ''
  let additions = 0
  let removals = 0

  const addRemoval = (token: string) => {
    removals += token.length
    html += `<del style="background: rgba(239, 68, 68, 0.25); color: #f87171; text-decoration: line-through; border-radius: 2px; padding: 0 2px;">${escapeHtml(token)}</del>`
  }

  const addAddition = (token: string) => {
    additions += token.length
    html += `<ins style="background: rgba(34, 197, 94, 0.25); color: #4ade80; text-decoration: none; border-radius: 2px; padding: 0 2px; font-weight: 500;">${escapeHtml(token)}</ins>`
  }

  while (i < N && j < M) {
    if (oldTokens[i] === newTokens[j]) {
      html += escapeHtml(oldTokens[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      addRemoval(oldTokens[i])
      i++
    } else {
      addAddition(newTokens[j])
      j++
    }
  }

  while (i < N) {
    addRemoval(oldTokens[i])
    i++
  }

  while (j < M) {
    addAddition(newTokens[j])
    j++
  }

  return { html, additions, removals }
}

export function showDiffPreviewModal(
  ctx: SpindleFrontendContext,
  diffItems: FieldDiffItem[],
  onConfirm: (approvedFields: FieldDiffItem[]) => void
) {
  const modifiedFields = diffItems.filter((d) => d.oldValue !== d.newValue)

  if (modifiedFields.length === 0) {
    return false
  }

  const approvedFields = new Set(modifiedFields.map((field) => field.fieldId))

  const modal = ctx.ui.showModal({
    title: `Preview Changes (${approvedFields.size}/${modifiedFields.length} fields modified)`,
    width: 1200,
    maxHeight: 900,
  })

  const shell = document.createElement('div')
  shell.style.cssText = `
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    max-height: 100%;
    gap: 10px;
  `

  const updateTitle = () => {
    modal.setTitle(
      `Preview Changes (${approvedFields.size}/${modifiedFields.length} fields modified)`
    )
  }

  // ── Pinned Top Action Bar (Centered) ──
  const topBar = document.createElement('div')
  topBar.style.cssText = `
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--lumiverse-border, rgba(128, 128, 128, 0.2));
  `

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.cssText = `
    background: var(--lumiverse-fill-subtle, rgba(255, 255, 255, 0.08));
    color: var(--lumiverse-text, rgba(255, 255, 255, 0.9));
    border: 1px solid var(--lumiverse-border, rgba(128, 128, 128, 0.3));
    border-radius: 6px;
    padding: 7px 20px;
    font-size: 12.5px;
    cursor: pointer;
    font-weight: 500;
  `
  cancelBtn.addEventListener('click', () => modal.dismiss())

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.textContent = 'Apply Changes'
  applyBtn.style.cssText = `
    background: var(--lumiverse-accent, #9370db);
    color: var(--lumiverse-accent-fg, #ffffff);
    border: 1px solid var(--lumiverse-accent, #9370db);
    border-radius: 6px;
    padding: 7px 24px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  `
  applyBtn.addEventListener('click', () => {
    const approved = modifiedFields.filter((field) =>
      approvedFields.has(field.fieldId)
    )

    onConfirm(approved)
    modal.dismiss()
  })

  topBar.append(cancelBtn, applyBtn)

  // ── Scrollable Diff Body ──
  const body = document.createElement('div')
  body.style.cssText = `
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 2px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  `

  const intro = document.createElement('div')
  intro.style.cssText = `
    font-size: 12px;
    color: var(--lumiverse-text-dim, rgba(255, 255, 255, 0.6));
    margin-bottom: 2px;
  `
  intro.innerHTML = `
    Review replacements across all fields before applying. Deletions are in
    <span style="color: #f87171; font-weight: 500;">red</span> and additions in
    <span style="color: #4ade80; font-weight: 500;">green</span>.
  `
  body.appendChild(intro)

  for (const field of modifiedFields) {
    const card = document.createElement('div')
    card.style.cssText = `
      background: var(--lumiverse-fill, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--lumiverse-border, rgba(128, 128, 128, 0.2));
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    `

    const diff = computeWordDiff(field.oldValue, field.newValue)

    const header = document.createElement('div')
    header.style.cssText = `
      background: var(--lumiverse-fill-subtle, rgba(255, 255, 255, 0.06));
      padding: 8px 12px;
      font-weight: 600;
      font-size: 12.5px;
      border-bottom: none;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
    `

    const counts = document.createElement('span')
    counts.innerHTML = `
      <span style="color: #4ade80;">+${diff.additions}</span>,
      <span style="color: #f87171;">-${diff.removals}</span>
    `
    counts.style.cssText = `
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    `

    const arrow = document.createElement('span')
    arrow.textContent = '▶'
    arrow.style.cssText = `
      flex-shrink: 0;
      color: var(--lumiverse-accent, #9370db);
      font-size: 11px;
    `

    const label = document.createElement('span')
    label.textContent = field.label
    label.style.cssText = `
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `

    const approvalLabel = document.createElement('label')
    approvalLabel.style.cssText = `
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: normal;
      color: var(--lumiverse-text-dim, rgba(255, 255, 255, 0.6));
      cursor: pointer;
    `
    approvalLabel.title = 'Approve or exclude this field'

    const approvalCheckbox = document.createElement('input')
    approvalCheckbox.type = 'checkbox'
    approvalCheckbox.checked = true
    approvalCheckbox.addEventListener('click', (event) => {
      event.stopPropagation()
    })
    approvalCheckbox.addEventListener('change', () => {
      if (approvalCheckbox.checked) {
        approvedFields.add(field.fieldId)
      } else {
        approvedFields.delete(field.fieldId)
      }
      updateTitle()
    })

    approvalLabel.appendChild(approvalCheckbox)

    if (field.sublabel) {
      const sublabel = document.createElement('span')
      sublabel.textContent = field.sublabel
      sublabel.style.cssText = `
        font-size: 11px;
        color: var(--lumiverse-text-dim, rgba(255, 255, 255, 0.5));
        font-weight: normal;
        text-align: right;
        max-width: 25%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `
      header.append(counts, arrow, label, sublabel, approvalLabel)
    } else {
      header.append(counts, arrow, label, approvalLabel)
    }

    const diffContent = document.createElement('div')
    diffContent.style.cssText = `
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 280px;
      overflow-y: auto;
      display: none;
      border-top: 1px solid var(--lumiverse-border, rgba(128, 128, 128, 0.2));
    `
    diffContent.innerHTML = diff.html

    header.addEventListener('click', () => {
      const isOpen = diffContent.style.display !== 'none'
      diffContent.style.display = isOpen ? 'none' : 'block'
      arrow.textContent = isOpen ? '▶' : '▼'
    })

    card.append(header, diffContent)
    body.appendChild(card)
  }

  shell.append(topBar, body)
  modal.root.appendChild(shell)


  return true
}
