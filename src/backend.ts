declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const PRESETS_STORAGE_FILE = 'regex_presets.json'
const CACHE_TTL_MS = 60_000
const BATCH_MAX_OPS = 64
const BATCH_CHUNK_BYTES = 900_000
const BATCH_OVERSIZE_BYTES = 950_000
// Kill switch for the spindle.batch path — flip to false to force per-entity IPC saves.
const USE_BATCH = true
const DEBUG_TIMING = false
const textEncoder = new TextEncoder()

type BatchOp = { domain: string; op: string; args: Record<string, any> }
type BatchResult = { ok: boolean; result?: any; error?: string }

class BatchFailure extends Error {
  readonly isRevisionConflict: boolean
  // Ops that committed before this failure (all-or-nothing only holds when this is 0).
  readonly committedBeforeFailure: number
  constructor(message: string, isRevisionConflict: boolean, committedBeforeFailure = 0) {
    super(message)
    this.name = 'BatchFailure'
    this.isRevisionConflict = isRevisionConflict
    this.committedBeforeFailure = committedBeforeFailure
  }
}

// The host flags a rolled-back op with a "BATCH_ROLLED_BACK: " prefix — strip it once at origination.
function stripBatchPrefix(message: string): string {
  return message.replace(/^BATCH_ROLLED_BACK:\s*/i, '')
}

function isRevisionConflictMessage(message: string): boolean {
  return /changed since revision|revision conflict|WORLD_BOOK_ENTRY_CONFLICT/i.test(message)
}

// Older hosts answer "Unrecognized message type" — latch batch off for the session.
function isBatchUnsupportedError(message: string): boolean {
  return /unrecognized message type|unknown request type|unsupported message type|not a function/i.test(message)
}

// Latched permanently once the host can't serve spindle_batch — all later saves use per-entity IPC.
let batchBroken = false
// op-level unsupported results also mean batch is unusable — latch for the NEXT save (this run keeps all-or-nothing).
const OP_UNSUPPORTED_RE = /unsupported batch operation|unrecognized message type|unknown request type/i
function latchBatchIfUnsupported(errorMessage?: string): boolean {
  if (batchBroken || !errorMessage || !OP_UNSUPPORTED_RE.test(errorMessage)) return false
  batchBroken = true
  spindle.log.error(`[regex-studio] spindle.batch rejected ops (${errorMessage.slice(0, 120)}); falling back to per-entity saves`)
  return true
}

const cacheKey = (userId?: string) => userId ?? 'operator'
const charCacheKey = (userId: string | undefined, id: string) => `${cacheKey(userId)}::${id}`
const charListCache = new Map<string, { at: number; items: Array<{ id: string; name: string; tags: string[] }> }>()
const charCache = new Map<string, { at: number; dto: any }>()
const wbListCache = new Map<string, { at: number; items: Array<{ id: string; name: string }> }>()
// Latest-wins sequencing for get_batch_characters — stale responses are never sent.
let batchFetchSeq = 0
let charCacheGeneration = 0

function isFresh(at: number): boolean {
  return Date.now() - at < CACHE_TTL_MS
}

function dropCharCache(ids: Array<string | undefined>) {
  const set = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (set.length === 0) return
  for (const key of [...charCache.keys()]) {
    if (set.some((id) => key.endsWith(`::${id}`))) charCache.delete(key)
  }
  // Bump even with zero cache hits — in-flight fetches for never-cached ids must also not re-cache pre-save DTOs.
  charCacheGeneration++
}

// Keep cached list names consistent with freshly saved patches (id → new name).
function updateCachedListNames(names: Array<{ id: string; name?: string }>) {
  const valid = names.filter((n) => typeof n.name === 'string' && n.name.length > 0)
  if (valid.length === 0) return
  for (const entry of charListCache.values()) {
    for (const item of entry.items) {
      const hit = valid.find((n) => n.id === item.id)
      if (hit) item.name = hit.name as string
    }
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function executeIndividually(ops: BatchOp[], executor: (op: BatchOp) => Promise<any>, concurrency = 8): Promise<BatchResult[]> {
  return mapWithConcurrency(ops, concurrency, async (op): Promise<BatchResult> => {
    try {
      return { ok: true, result: await executor(op) }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })
}

// Chunk under the host caps (64 ops / 1 MiB encoded). Oversized single ops are excluded
// and fall back to per-entity calls — indices are preserved for positional zip-back.
function chunkForBatch(ops: BatchOp[]): { chunks: Array<Array<{ index: number; op: BatchOp }>>; oversized: Array<{ index: number; op: BatchOp }> } {
  const chunks: Array<Array<{ index: number; op: BatchOp }>> = []
  const oversized: Array<{ index: number; op: BatchOp }> = []
  let current: Array<{ index: number; op: BatchOp }> = []
  let currentBytes = 0
  ops.forEach((op, index) => {
    const bytes = textEncoder.encode(JSON.stringify(op)).byteLength
    if (bytes > BATCH_OVERSIZE_BYTES) {
      oversized.push({ index, op })
      return
    }
    if (current.length > 0 && (current.length >= BATCH_MAX_OPS || currentBytes + bytes >= BATCH_CHUNK_BYTES)) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push({ index, op })
    currentBytes += bytes
  })
  if (current.length > 0) chunks.push(current)
  return { chunks, oversized }
}

async function runBatch(
  ops: BatchOp[],
  opts: { expectedRevisions?: Record<string, number>; userId?: string; executeFallback: (op: BatchOp) => Promise<any> },
): Promise<BatchResult[]> {
  const results: BatchResult[] = ops.map(() => ({ ok: false, error: 'Not executed' }))
  // Feature-detect once: hosts without spindle.batch latch off before any chunk is attempted.
  if (typeof (spindle as any).batch !== 'function') {
    batchBroken = true
    spindle.log.error('[regex-studio] spindle.batch unavailable (not a function); falling back to per-entity saves')
  }
  const { chunks, oversized } = chunkForBatch(ops)
  let committed = 0
  for (const { index, op } of oversized) {
    try {
      results[index] = { ok: true, result: await opts.executeFallback(op) }
      committed++
    } catch (err: any) {
      results[index] = { ok: false, error: stripBatchPrefix(err?.message || String(err)) }
    }
  }
  for (const chunk of chunks) {
    if (!batchBroken) {
      try {
        const chunkResults: BatchResult[] = await (spindle as any).batch(
          chunk.map(({ op }) => op),
          {
            ...(opts.expectedRevisions ? { expected_revisions: opts.expectedRevisions } : {}),
            ...(opts.userId ? { userId: opts.userId } : {}),
          },
        )
        let firstError: string | null = null
        chunk.forEach((entry, i) => {
          const r = Array.isArray(chunkResults) ? chunkResults[i] : undefined
          if (r?.ok) {
            results[entry.index] = { ok: true, result: r.result }
            committed++
          } else {
            const message = stripBatchPrefix(r?.error || 'Batch operation failed')
            latchBatchIfUnsupported(message)
            results[entry.index] = { ok: false, error: message }
            if (!firstError) firstError = message
          }
        })
        if (firstError) throw new BatchFailure(firstError, isRevisionConflictMessage(firstError), committed)
        continue
      } catch (err: any) {
        if (err instanceof BatchFailure) throw err
        const message = stripBatchPrefix(err?.message || String(err))
        if (!isBatchUnsupportedError(message)) {
          // Chunk-level failure — earlier chunks may have committed; don't start the next chunk.
          chunk.forEach(({ index }) => { results[index] = { ok: false, error: message } })
          throw new BatchFailure(message, isRevisionConflictMessage(message), committed)
        }
        batchBroken = true
        spindle.log.error(`[regex-studio] spindle.batch unavailable (${message}); falling back to per-entity saves`)
      }
    }
    // batchBroken latched (or was already latched) — per-entity fallback for this chunk.
    // All-or-nothing does NOT hold here: each entity saves independently.
    const fallbackResults = await executeIndividually(chunk.map(({ op }) => op), opts.executeFallback, 8)
    let firstError: string | null = null
    chunk.forEach((entry, i) => {
      const r = fallbackResults[i]
      results[entry.index] = r
      if (r.ok) committed++
      else {
        const message = stripBatchPrefix(r.error || 'Operation failed')
        latchBatchIfUnsupported(message)
        if (!firstError) firstError = message
      }
    })
    if (firstError) throw new BatchFailure(firstError, isRevisionConflictMessage(firstError), committed)
  }
  return results
}

async function executeSaveOps(
  ops: BatchOp[],
  opts: { expectedRevisions?: Record<string, number>; userId?: string; executeFallback: (op: BatchOp) => Promise<any> },
): Promise<BatchResult[]> {
  const results =
    USE_BATCH && !batchBroken ? await runBatch(ops, opts) : await executeIndividually(ops, opts.executeFallback, 8)
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) return results
  // Covers oversized ops that bypass the per-chunk early throw — if anything failed, the caller must not see success.
  const summaries = results
    .map((r, i) => ({ r, op: ops[i] }))
    .filter((x) => !x.r.ok)
    .map((x) => `${x.op.args.id ?? x.op.args.entryId ?? x.op.op} (${stripBatchPrefix(x.r.error || 'Operation failed')})`)
  const detail = summaries.length > 3
    ? `${summaries.slice(0, 3).join('; ')}… and ${summaries.length - 3} more`
    : summaries.join('; ')
  throw new BatchFailure(detail, isRevisionConflictMessage(detail), results.length - failed.length)
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!DEBUG_TIMING) return fn()
  const start = Date.now()
  try {
    return await fn()
  } finally {
    spindle.log.info(`[regex-studio] ${label}: ${Date.now() - start}ms`)
  }
}

// Page 1 first, then the remaining pages concurrently (computed from `total`).
// Falls back to a sequential loop when the host omits `total`. Duplicate ids
// (overlapping pages) are dropped; the parallel fan-out is capped at 50 pages.
async function fetchPaged(fetchPage: (limit: number, offset: number) => Promise<{ data?: any[]; total?: number }>): Promise<any[]> {
  const limit = 200
  const seen = new Set<string>()
  const append = (target: any[], page: any[]) => {
    for (const item of page) {
      if (item?.id) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
      }
      target.push(item)
    }
  }
  const first = await fetchPage(limit, 0)
  const firstRaw = first.data || []
  const firstItems: any[] = []
  append(firstItems, firstRaw)
  const fetched = firstRaw.length
  if (typeof first.total !== 'number') {
    if (fetched < limit) return firstItems
    const items = [...firstItems]
    let offset = fetched
    while (true) {
      const page = await fetchPage(limit, offset)
      const pageItems = page.data || []
      append(items, pageItems)
      if (pageItems.length < limit) break
      offset += pageItems.length
    }
    return items
  }
  const rawRemaining = Math.ceil((first.total - fetched) / limit)
  const remainingPages = Math.min(Math.max(rawRemaining, 0), 50)
  if (rawRemaining > 50) spindle.log.info(`[regex-studio] fetchPaged: clamping ${rawRemaining} remaining pages to 50`)
  if (remainingPages <= 0) return firstItems
  const pages = await Promise.all(Array.from({ length: remainingPages }, (_, i) => fetchPage(limit, fetched + i * limit)))
  const items = [...firstItems]
  for (const page of pages) append(items, page.data || [])
  return items
}

// Helpers for characters and world books pagination
async function fetchAllCharacters(userId?: string) {
  const items = await fetchPaged((limit, offset) => spindle.characters.list({ limit, offset, userId } as any))
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    tags: Array.isArray(item.tags) ? item.tags : [],
  }))
}

async function fetchAllWorldBooks(userId?: string) {
  const items = await fetchPaged((limit, offset) => spindle.world_books.list({ limit, offset, userId } as any))
  return items.map((item) => ({ id: item.id, name: item.name }))
}

// ── Preset store: in-memory cache + compact atomic persist, serialized writes ──
let presetsCache: any[] | null = null
let presetWriteQueue: Promise<unknown> = Promise.resolve()

async function loadPresets(): Promise<any[]> {
  if (presetsCache) return presetsCache
  // Read failures propagate on purpose — a corrupted file must never be silently reset to [].
  const data = await spindle.storage.getJson(PRESETS_STORAGE_FILE)
  presetsCache = Array.isArray(data) ? data : []
  return presetsCache
}

// Read-modify-write entirely inside the serialized chain — concurrent handlers can't lose updates.
async function mutatePresets(mutator: (list: any[]) => any[]): Promise<any[]> {
  const run = presetWriteQueue.then(async (): Promise<any[]> => {
    const current = await loadPresets()
    const next = mutator(current)
    presetsCache = next
    try {
      // tmp + rename keeps the on-disk file valid JSON even if the write is interrupted.
      await spindle.storage.setJson(`${PRESETS_STORAGE_FILE}.tmp`, next, { indent: 0 })
      await spindle.storage.move(`${PRESETS_STORAGE_FILE}.tmp`, PRESETS_STORAGE_FILE)
    } catch (err: any) {
      spindle.log.error(`[regex-studio] Preset persist failed: ${err?.message || err}`)
      // Best-effort restore to on-disk truth — only if no newer write landed since.
      if (presetsCache === next) {
        try {
          const disk = await spindle.storage.getJson(PRESETS_STORAGE_FILE)
          presetsCache = Array.isArray(disk) ? disk : []
        } catch {
          // Keep the intended state; the caller surfaces the error.
        }
      }
      throw err
    }
    return next
  })
  presetWriteQueue = run.catch(() => {})
  return run
}

spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    switch (payload.type) {
      // ── Preset Library Actions ──
      case 'load_presets': {
        try {
          const presets = await loadPresets()
          spindle.sendToFrontend({ type: 'presets_loaded', presets }, userId)
        } catch (err: any) {
          spindle.toast.error(`Failed to load presets: ${err?.message || err}`, { title: 'Preset Load Failed' })
          // Deliberately no presets_loaded — the frontend keeps its current list; the file stays untouched.
          spindle.sendToFrontend({ type: 'error', message: err?.message || String(err) }, userId)
        }
        break
      }

      case 'save_preset': {
        try {
          const presets = await mutatePresets((list) => {
            const existingIdx = list.findIndex((p) => p.id === payload.preset.id)
            if (existingIdx >= 0) return list.map((p, i) => (i === existingIdx ? payload.preset : p))
            return [...list, payload.preset]
          })
          spindle.toast.success(`Preset "${payload.preset.name}" saved!`)
          spindle.sendToFrontend({ type: 'presets_loaded', presets }, userId)
        } catch (err: any) {
          spindle.toast.error(`Preset save failed: ${err?.message || err}`, { title: 'Preset Save Failed' })
          spindle.sendToFrontend({ type: 'presets_loaded', presets: presetsCache ?? [] }, userId)
        }
        break
      }

      case 'delete_preset': {
        try {
          let removed = false
          const presets = await mutatePresets((list) => {
            const next = list.filter((p) => p.id !== payload.presetId)
            removed = next.length !== list.length
            return next
          })
          spindle.toast.info(removed ? 'Preset deleted.' : 'Preset not found.')
          spindle.sendToFrontend({ type: 'presets_loaded', presets }, userId)
        } catch (err: any) {
          spindle.toast.error(`Preset delete failed: ${err?.message || err}`, { title: 'Preset Delete Failed' })
          spindle.sendToFrontend({ type: 'presets_loaded', presets: presetsCache ?? [] }, userId)
        }
        break
      }

      // ── Character Card Actions ──
      case 'list_characters': {
        if (payload.force !== true) {
          const cached = charListCache.get(cacheKey(userId))
          if (cached && isFresh(cached.at)) {
            spindle.sendToFrontend({ type: 'characters_list', characters: cached.items }, userId)
            break
          }
        }
        const characters = await timed('list_characters', () => fetchAllCharacters(userId))
        charListCache.set(cacheKey(userId), { at: Date.now(), items: characters })
        spindle.sendToFrontend({ type: 'characters_list', characters }, userId)
        break
      }

      case 'get_character': {
        const gen = charCacheGeneration
        const key = charCacheKey(userId, payload.characterId)
        const cached = charCache.get(key)
        if (cached && isFresh(cached.at)) {
          spindle.sendToFrontend({ type: 'character_data', character: cached.dto }, userId)
          break
        }
        const char = await timed('get_character', () => spindle.characters.get(payload.characterId, userId as any))
        // Skip storing if a save invalidated the DTO cache mid-flight.
        if (char && gen === charCacheGeneration) charCache.set(key, { at: Date.now(), dto: char })
        spindle.sendToFrontend({ type: 'character_data', character: char }, userId)
        break
      }

      case 'get_batch_characters': {
        const seq = ++batchFetchSeq
        const gen = charCacheGeneration
        try {
          const ids: string[] = payload.characterIds || []
          const fetched = await timed('get_batch_characters', () =>
            mapWithConcurrency(ids, 8, async (id) => {
              const key = charCacheKey(userId, id)
              try {
                const cached = charCache.get(key)
                if (cached && isFresh(cached.at)) return cached.dto
                const char = await spindle.characters.get(id, userId as any)
                // Skip storing if a save invalidated the DTO cache mid-flight — refetch next time.
                if (char && gen === charCacheGeneration) charCache.set(key, { at: Date.now(), dto: char })
                return char
              } catch (err: any) {
                // One card failing must not fail the whole batch — caller drops nulls.
                spindle.log.error(`[regex-studio] get_batch_characters: ${id}: ${err?.message || err}`)
                return null
              }
            }),
          )
          if (seq !== batchFetchSeq) {
            spindle.log.info(`[regex-studio] Dropping stale batch_characters_data (seq ${seq}, latest ${batchFetchSeq})`)
            break
          }
          spindle.sendToFrontend({ type: 'batch_characters_data', characters: fetched.filter(Boolean) }, userId)
        } catch (err: any) {
          if (seq !== batchFetchSeq) {
            spindle.log.info(`[regex-studio] Dropping stale batch_characters_data error (seq ${seq}, latest ${batchFetchSeq})`)
            break
          }
          spindle.sendToFrontend({ type: 'error', message: err?.message || String(err) }, userId)
        }
        break
      }

      case 'save_character': {
        await timed('save_character', () => spindle.characters.update(payload.characterId, payload.patch, userId as any))
        dropCharCache([payload.characterId])
        updateCachedListNames([{ id: payload.characterId, name: payload.patch?.name }])
        spindle.toast.success(`Character "${payload.name || 'card'}" updated!`)
        spindle.sendToFrontend({ type: 'save_success', entityType: 'character' }, userId)
        break
      }

      case 'save_batch_characters': {
        const updates: Array<{ id: string; name?: string; patch: Record<string, any> }> = payload.updates || []
        if (updates.length === 0) {
          spindle.sendToFrontend({ type: 'save_success', entityType: 'character_batch', savedCount: 0 }, userId)
          break
        }
        const ops: BatchOp[] = updates.map((u) => ({
          domain: 'characters',
          op: 'update',
          args: { id: u.id, input: u.patch },
        }))
        const executeFallback = (op: BatchOp) => spindle.characters.update(op.args.id, op.args.input, userId as any)
        try {
          await timed('save_batch_characters', () => executeSaveOps(ops, { userId, executeFallback }))
        } catch (err: any) {
          const isConflict = err instanceof BatchFailure && err.isRevisionConflict
          const committed = err instanceof BatchFailure ? err.committedBeforeFailure : 0
          const reason = err?.message || String(err)
          // Fallback mode collects per-card failures into `reason`; batch mode reports the first reason.
          const message = `Batch save failed: ${reason}${committed > 0 ? ` — ${committed} card(s) may have been saved before the failure.` : ''}`
          // Conflicts: the frontend renders the payload verbatim — no double toast.
          if (!isConflict) spindle.toast.error(message, { title: 'Batch Save Failed' })
          spindle.sendToFrontend({ type: 'error', message, ...(isConflict ? { code: 'revision_conflict' } : {}) }, userId)
          break
        }
        dropCharCache(updates.map((u) => u.id))
        updateCachedListNames(updates.map((u) => ({ id: u.id, name: u.patch?.name ?? u.name })))
        spindle.toast.success(`Batch updated ${updates.length} character cards!`)
        spindle.sendToFrontend({ type: 'save_success', entityType: 'character_batch', savedCount: updates.length }, userId)
        break
      }

      // ── Lorebook Actions ──
      case 'list_world_books': {
        if (payload.force !== true) {
          const cached = wbListCache.get(cacheKey(userId))
          if (cached && isFresh(cached.at)) {
            spindle.sendToFrontend({ type: 'world_books_list', worldBooks: cached.items }, userId)
            break
          }
        }
        const worldBooks = await timed('list_world_books', () => fetchAllWorldBooks(userId))
        wbListCache.set(cacheKey(userId), { at: Date.now(), items: worldBooks })
        spindle.sendToFrontend({ type: 'world_books_list', worldBooks }, userId)
        break
      }

      // No latest-wins seq for world-book loads: entry fetches are a single bounded
      // parallel fan-out per request, not a rapid supersede pattern like batch selection.
      case 'get_world_book': {
        const allEntries: any[] = await timed('get_world_book', () =>
          fetchPaged((limit, offset) =>
            spindle.world_books.entries.list(payload.worldBookId, { limit, offset, userId } as any),
          ),
        )
        spindle.sendToFrontend({ type: 'world_book_data', worldBookId: payload.worldBookId, entries: allEntries }, userId)
        break
      }

      case 'save_world_book_entries': {
        const { updates, expectedRevisions } = payload as { updates?: Array<{ id: string; content: string }>; expectedRevisions?: Record<string, number> }
        const list = Array.isArray(updates) ? updates : []
        if (list.length === 0) {
          spindle.toast.info('Nothing to save')
          spindle.sendToFrontend({ type: 'save_success', entityType: 'world_book', savedCount: 0 }, userId)
          break
        }
        const ops: BatchOp[] = list.map((update) => ({
          domain: 'world_books',
          op: 'entries.update',
          args: { entryId: update.id, input: { content: update.content } },
        }))
        // Fallback passes expected_revision per entry so the conflict check still applies per entry.
        // All-or-nothing only holds via spindle.batch — the fallback saves independently.
        const executeFallback = (op: BatchOp) => {
          const entryId = op.args.entryId
          const revision = expectedRevisions?.[entryId]
          const input = { ...op.args.input, ...(revision !== undefined ? { expected_revision: revision } : {}) }
          return spindle.world_books.entries.update(entryId, input, userId as any)
        }
        let results: BatchResult[] | undefined
        try {
          results = await timed('save_world_book_entries', () =>
            executeSaveOps(ops, { userId, executeFallback, expectedRevisions }),
          )
        } catch (err: any) {
          const isConflict = err instanceof BatchFailure && err.isRevisionConflict
          const committed = err instanceof BatchFailure ? err.committedBeforeFailure : 0
          const reason = err?.message || String(err)
          if (isConflict) {
            // "Nothing was saved" only holds when no op committed (single chunk / fully rolled back).
            // Conflict: frontend renders the payload verbatim — no double toast.
            const message = committed === 0
              ? 'Lorebook save failed: an entry was changed outside Regex Studio. Nothing was saved. Re-select the lorebook from the dropdown to reload it from the server (local edits will be discarded).'
              : 'Lorebook save failed: an entry was changed outside Regex Studio. Some entries may have been saved before the conflict. Re-select the lorebook from the dropdown to reload it from the server, then re-check the diff.'
            spindle.sendToFrontend({ type: 'error', code: 'revision_conflict', message }, userId)
            break
          }
          const message = `Lorebook save failed: ${reason}${committed > 0 ? ` — ${committed} ${committed === 1 ? 'entry' : 'entries'} may have been saved before the failure.` : ''}`
          spindle.toast.error(message, { title: 'Lorebook Save Failed' })
          spindle.sendToFrontend({ type: 'error', message }, userId)
          break
        }
        // Updated-entry DTOs carry the new integer revision — hand them back so the session
        // can re-anchor expectedRevisions and repeat saves don't false-conflict.
        const revisions = (results ?? [])
          .map((r, i) => {
            const rawId = ops[i]?.args?.entryId as unknown
            const id = typeof rawId === 'string' && rawId ? rawId : rawId != null ? String(rawId) : null
            return { id, revision: Number(r.result?.revision) }
          })
          .filter((x) => x.id !== null && Number.isInteger(x.revision) && x.revision >= 1)
          .map((x) => ({ id: x.id as string, revision: x.revision }))
        spindle.toast.success(`Updated ${list.length} lorebook entries!`)
        spindle.sendToFrontend({
          type: 'save_success',
          entityType: 'world_book',
          savedCount: list.length,
          ...(revisions.length > 0 ? { revisions } : {}),
        }, userId)
        break
      }
    }
  } catch (err: any) {
    spindle.log.error(`[regex-studio] Error: ${err.message}`)
    spindle.toast.error(err.message, { title: 'Operation Failed' })
    spindle.sendToFrontend({ type: 'error', message: err.message }, userId)
  }
})
