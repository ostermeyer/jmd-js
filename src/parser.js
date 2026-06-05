// SPDX-License-Identifier: Apache-2.0
// JMD parser.
//
// The parser processes a JMD document line by line, maintaining a scope
// stack driven by heading depth. It has two surfaces:
//
//   - parse(text)          — batch. Returns { mode, label, frontmatter, value }.
//   - events(lineSource)   — streaming. Async generator of parse events.
//
// Both share the same line-processing core. Events follow the sequence
// defined in JMD spec §18.2. Parser-tolerant per §22.1.
//
// Spec coverage: v0.3.3 — including §7.4 repeated-heading promotion with
// three structured errors (sigil_conflict, repeated_explicit_array,
// repeated_scalar_key), §3.5.1 frontmatter `---` marker tolerance, and
// §5.2 multi-line block scalars (`|` literal, `>` folded).

import { parseScalar, parseKey, parseField } from './value.js'

const HEADING = /^(#+)([!?-])?(?:\s+(.*))?$/

// §7.4 — kinds tracked per object scope to detect repeated-heading
// conflicts and to drive implicit-array promotion.
const K_OBJECT_HEADING = 1   // `## foo` opened an object scope
const K_ARRAY_SIGIL = 2      // `## foo[]` opened an explicit array
const K_ARRAY_PROMOTED = 3   // two `## foo` collapsed into an array
const K_SCALAR_BARE = 4      // `foo: 1` at column 0
const K_SCALAR_HEADING = 5   // `## foo: 1`

// Structured parse error — `kind` lets callers distinguish the §7.4
// conditions (and any other tagged failures we add later) from generic
// malformed-input errors. The line number is appended to the message
// for legibility but also stored separately on the error.
export class JMDParseError extends Error {
  constructor(kind, message, line) {
    super(message + ' (line ' + line + ')')
    this.name = 'JMDParseError'
    this.kind = kind
    this.line = line
  }
}

export function createParser() {
  let lineNo = 0

  // Document-level state.
  let mode = null
  let label = null
  const frontmatter = {}
  let inFrontmatter = true
  let frontmatterStarted = false  // §3.5.1: have we seen any frontmatter field?
  let seenRoot = false
  let root = null

  // Scope stack. Each entry:
  //   { kind: 'object' | 'array', container, depth,
  //     seen: Map<key, K_*>,        // object scopes only
  //     currentItem?, itemSeen? }   // array scopes only
  // currentItem lives on array scopes and holds the object built by the
  // most recent `- ` line so indented continuations attach to it.
  // itemSeen mirrors `seen` for that per-item object.
  let stack = []

  // Pending blockquote state.
  //   { container, key, lines }
  let bq = null

  // Pending block-scalar state (§5.2).
  //   { container, key, kind: '|' | '>', lines, baseIndent }
  // baseIndent is null until the first content line establishes it.
  let block = null

  // A blank line may or may not terminate the current scope — it depends on
  // what comes after. We defer the decision: flag the blank, then let the
  // next real line resolve it. A deeper heading re-enters (no reset); a bare
  // field at the root indicates a scope return (full reset); a `---` inside
  // an array is a thematic break (item separator, §8.6).
  let blankPending = false

  // Events emitted by the current line — drained on each processLine call.
  let pending = []
  function emit(type, data) {
    pending.push(data ? { type, ...data } : { type })
  }
  function drain() {
    const out = pending
    pending = []
    return out
  }

  // --- Line processing -----------------------------------------------------

  function processLine(rawLine) {
    lineNo++
    const line = rawLine.replace(/\r$/, '')

    if (block !== null) {
      if (processBlockLine(line)) return drain()
      // Block ended; fall through to normal line handling.
    }

    if (bq !== null) {
      if (line === '>' || line.startsWith('> ')) {
        const content = line === '>' ? '' : line.slice(2)
        bq.lines.push(content)
        emit('field_content', { text: content })
        return drain()
      }
      commitBlockquote()
    }

    if (/^\s*$/.test(line)) { blankPending = true; return drain() }

    const h = HEADING.exec(line)
    if (h) {
      // A heading stands on its own authority — its depth drives scope.
      blankPending = false
      onHeading(h[1].length, h[2] || '', h[3] || '')
      return drain()
    }

    if (inFrontmatter) { onFrontmatter(line); return drain() }

    if (/^\s{2,}/.test(line)) {
      blankPending = false
      onIndented(line)
      return drain()
    }

    // Thematic break: `---` (or more) at column 0, only meaningful inside
    // an array scope, where it terminates the current item.
    if (/^-{3,}$/.test(line)) {
      onThematicBreak()
      return drain()
    }

    if (line === '-' || line.startsWith('- ')) {
      if (blankPending) applyBlankReset()
      onItem(line)
      return drain()
    }

    if (blankPending) applyBlankReset()
    onField(line)
    return drain()
  }

  function applyBlankReset() {
    blankPending = false
    if (stack.length <= 1) return
    emit('scope_reset')
    while (stack.length > 1) popScope()
    if (stack[0] && stack[0].kind === 'array') closeItem(stack[0])
  }

  function onThematicBreak() {
    blankPending = false
    // A thematic break closes any sub-scope opened by the most-recent
    // item, then signals the next item of the enclosing array (spec §8.6).
    // We search outward for the innermost array whose last item opened a
    // sub-structure and close down to it. If none qualifies, the break is
    // a no-op — and that is correct, not lossy: a flat item opens no
    // sub-scope, so the enclosing array is still current and the next
    // `- ` item continues it. This is why a `---` after a flat item in a
    // mixed array (canonical per the v0.3.4 §8.6 clarification) parses
    // without dropping the following item.
    let targetIdx = -1
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]
      if (s.kind !== 'array') continue
      const last = s.container[s.container.length - 1]
      if (last && typeof last === 'object' && !Array.isArray(last)
          && Object.values(last).some(
            v => v !== null && typeof v === 'object')) {
        targetIdx = i
        break
      }
    }
    if (targetIdx === -1) return
    while (stack.length - 1 > targetIdx) popScope()
    closeItem(stack[targetIdx])
  }

  // --- Blockquote ----------------------------------------------------------

  function startBlockquote(container, key) {
    bq = { container, key, lines: [] }
    emit('field_start', { key })
  }

  function commitBlockquote() {
    bq.container[bq.key] = bq.lines.join('\n')
    bq = null
  }

  // --- Block scalars (§5.2) ------------------------------------------------

  function startBlock(container, key, kind) {
    block = { container, key, kind, lines: [], baseIndent: null }
    emit('field_start', { key })
  }

  // Returns true if the line was consumed by the block scalar, false if it
  // signals the block has ended and the line must be re-dispatched normally.
  function processBlockLine(line) {
    if (line === '') {
      block.lines.push('')
      return true
    }
    const m = /^(\s*)/.exec(line)
    const indent = m[0].length
    if (block.baseIndent === null) {
      if (indent === 0) {
        commitBlock()
        return false
      }
      block.baseIndent = indent
      block.lines.push(line.slice(indent))
      return true
    }
    if (indent < block.baseIndent && /\S/.test(line)) {
      commitBlock()
      return false
    }
    block.lines.push(line.slice(block.baseIndent))
    return true
  }

  function commitBlock() {
    const lines = block.lines.slice()
    // Drop trailing blank lines for both kinds — spec §5.2 treats the
    // trailing newline as a line-terminator, not part of the value.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const value = block.kind === '|' ? lines.join('\n') : foldLines(lines)
    block.container[block.key] = value
    emit('field', { key: block.key, value })
    block = null
  }

  // Folded block scalar fold (§5.2):
  //   consecutive non-blank lines  →  joined with single space
  //   one blank between groups     →  one newline
  //   N+1 blank lines              →  N newlines
  function foldLines(lines) {
    let out = ''
    let group = []
    let blanks = 0
    function flushGroup() {
      if (group.length > 0) {
        out += group.join(' ')
        group = []
      }
    }
    for (const ln of lines) {
      if (ln === '') {
        flushGroup()
        blanks++
      } else {
        if (blanks > 0) {
          out += '\n'.repeat(blanks)
          blanks = 0
        }
        group.push(ln)
      }
    }
    flushGroup()
    return out
  }

  // --- Root / frontmatter --------------------------------------------------

  function onFrontmatter(line) {
    // §3.5.1: tolerate `---` (or more) marker lines bracketing the
    // frontmatter block. A marker before any field opens it; a marker
    // after the last field separates it from the root heading. Both
    // forms are consumed without emitting a frontmatter event.
    if (/^-{3,}$/.test(line)) {
      // Marker is structural-only — no state change beyond ignoring it.
      return
    }
    const f = parseField(line)
    if (f) {
      if (f.empty) {
        // D12: multi-line frontmatter value enters a blockquote that
        // collects subsequent `> ...` lines; commit assigns the joined
        // string to frontmatter[key] (handled by the bq state machine).
        frontmatterStarted = true
        startBlockquote(frontmatter, f.key)
        return
      }
      frontmatter[f.key] = f.value
      frontmatterStarted = true
      emit('frontmatter', { key: f.key, value: f.value })
      return
    }
    const pk = parseKey(line)
    if (pk && pk.rest === '') {
      frontmatter[pk.key] = true
      frontmatterStarted = true
      emit('frontmatter', { key: pk.key, value: true })
      return
    }
    throw new JMDParseError(
      'malformed_frontmatter',
      'Unexpected line before root heading',
      lineNo,
    )
  }

  function openRoot(modeMark, text) {
    inFrontmatter = false
    seenRoot = true

    if (modeMark === '!') mode = 'schema'
    else if (modeMark === '?') mode = 'query'
    else if (modeMark === '-') mode = 'delete'
    else mode = 'data'

    if (text === '[]') {
      label = '[]'
      root = []
      stack = [arrayScope(root, 1)]
    } else if (text.endsWith('[]')) {
      label = text.slice(0, -2)
      root = []
      stack = [arrayScope(root, 1)]
    } else {
      label = text
      root = {}
      stack = [objectScope(root, 1)]
    }
    emit('document_start', { mode, label })
  }

  function objectScope(container, depth) {
    return { kind: 'object', container, depth, seen: new Map() }
  }

  function arrayScope(container, depth) {
    return {
      kind: 'array', container, depth,
      currentItem: null, itemSeen: null,
    }
  }

  // --- Headings ------------------------------------------------------------

  function onHeading(depth, modeMark, text) {
    if (!seenRoot) {
      if (depth !== 1) {
        throw new JMDParseError(
          'malformed_root',
          'Document must begin with a depth-1 heading',
          lineNo,
        )
      }
      openRoot(modeMark, text)
      return
    }
    if (modeMark) {
      throw new JMDParseError(
        'malformed_heading',
        'Mode markers (!, ?, -) are only valid on the root heading',
        lineNo,
      )
    }

    // Depth-qualified array item (§8.6a) or depth+1 item (§8.6b):
    // `##N -` or `##N - key: val` starts a new item in an enclosing array.
    // Resolution prefers the innermost array at depth N; failing that, an
    // array at depth N-1 (the LLM-natural "items under the heading" form).
    if (text === '-' || text.startsWith('- ')) {
      onDepthQualifiedItem(depth, text)
      return
    }

    popToDepth(depth)

    if (text === '' || text === undefined) {
      openObjectScope(depth, '')
      return
    }

    // Anonymous sub-array: `### []` — handled below with the other array forms.
    if (text === '[]') {
      openSubArray(depth)
      return
    }

    if (text.endsWith('[]')) {
      const keyText = text.slice(0, -2)
      const pk = parseKey(keyText)
      if (!pk || pk.rest !== '') {
        throw new JMDParseError(
          'malformed_heading',
          'Malformed array heading key',
          lineNo,
        )
      }
      openArrayScope(depth, pk.key)
      return
    }

    const field = parseField(text)
    if (field && field.value !== undefined) {
      const { container, seen } = scalarParentAt(depth)
      checkScalar(seen, field.key, K_SCALAR_HEADING)
      container[field.key] = field.value
      emit('field', { key: field.key, value: field.value })
      return
    }

    if (field && field.empty) {
      const { container, seen } = scalarParentAt(depth)
      checkScalar(seen, field.key, K_SCALAR_HEADING)
      startBlockquote(container, field.key)
      return
    }

    if (field && field.block) {
      const { container, seen } = scalarParentAt(depth)
      checkScalar(seen, field.key, K_SCALAR_HEADING)
      startBlock(container, field.key, field.block)
      return
    }

    const pk = parseKey(text)
    if (pk && pk.rest === '') {
      openObjectScope(depth, pk.key)
      return
    }

    throw new JMDParseError(
      'malformed_heading',
      'Malformed heading',
      lineNo,
    )
  }

  function openObjectScope(depth, key) {
    const parent = parentScopeAt(depth)
    const { container, seen } = parentContainerAndSeen(parent)
    const prior = seen ? seen.get(key) : undefined

    if (prior === K_ARRAY_SIGIL) {
      throw new JMDParseError(
        'sigil_conflict',
        'Repeated heading "' + key + '" mixes [] sigil with bare form',
        lineNo,
      )
    }
    if (prior === K_SCALAR_BARE || prior === K_SCALAR_HEADING) {
      throw new JMDParseError(
        'repeated_scalar_key',
        'Key "' + key + '" first seen as scalar, then as object heading',
        lineNo,
      )
    }
    if (prior === K_ARRAY_PROMOTED) {
      // Third+ occurrence: append a fresh object to the existing array.
      const arr = container[key]
      const obj = {}
      arr.push(obj)
      stack.push(objectScope(obj, depth))
      emit('object_start', { key })
      return
    }
    if (prior === K_OBJECT_HEADING) {
      // §7.4: second occurrence promotes the scalar object to an array.
      const existing = container[key]
      const obj = {}
      const arr = [existing, obj]
      container[key] = arr
      if (seen) seen.set(key, K_ARRAY_PROMOTED)
      stack.push(objectScope(obj, depth))
      emit('object_start', { key })
      return
    }
    // First occurrence — plain object heading.
    const obj = {}
    container[key] = obj
    if (seen) seen.set(key, K_OBJECT_HEADING)
    stack.push(objectScope(obj, depth))
    emit('object_start', { key })
  }

  function openArrayScope(depth, key) {
    const parent = parentScopeAt(depth)
    const { container, seen } = parentContainerAndSeen(parent)
    const prior = seen ? seen.get(key) : undefined

    if (prior === K_ARRAY_SIGIL) {
      throw new JMDParseError(
        'repeated_explicit_array',
        'Repeated explicit-array heading "' + key + '"',
        lineNo,
      )
    }
    if (prior === K_OBJECT_HEADING || prior === K_ARRAY_PROMOTED) {
      throw new JMDParseError(
        'sigil_conflict',
        'Heading "' + key + '" first appeared without [], then with []',
        lineNo,
      )
    }
    if (prior === K_SCALAR_BARE || prior === K_SCALAR_HEADING) {
      throw new JMDParseError(
        'repeated_scalar_key',
        'Key "' + key + '" first seen as scalar, then as array heading',
        lineNo,
      )
    }
    const arr = []
    container[key] = arr
    if (seen) seen.set(key, K_ARRAY_SIGIL)
    stack.push(arrayScope(arr, depth))
    emit('array_start', { key })
  }

  function openSubArray(depth) {
    // `### []`: start a new anonymous array as the next item of the
    // enclosing array scope.
    const top = stack[stack.length - 1]
    if (!top || top.kind !== 'array') {
      throw new JMDParseError(
        'malformed_heading',
        'Anonymous sub-array outside array scope',
        lineNo,
      )
    }
    closeItem(top)
    const inner = []
    top.container.push(inner)
    stack.push(arrayScope(inner, depth))
    emit('array_start', {})
  }

  // Find the scope that should receive a scalar field at the given heading
  // depth, returning its container plus the `seen` map for §7.4 tracking.
  function scalarParentAt(depth) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]
      if (s.depth >= depth) continue
      if (s.kind === 'object') {
        return { container: s.container, seen: s.seen }
      }
      if (s.kind === 'array' && s.currentItem) {
        // Per-item object: track its own seen-keys so repeated keys on
        // one item still surface as repeated_scalar_key.
        if (s.itemSeen === null) s.itemSeen = new Map()
        return { container: s.currentItem, seen: s.itemSeen }
      }
      throw new JMDParseError(
        'malformed_field',
        'Field has no enclosing object scope',
        lineNo,
      )
    }
    throw new JMDParseError(
      'malformed_field',
      'No enclosing scope for depth ' + depth,
      lineNo,
    )
  }

  function parentScopeAt(depth) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].depth < depth) return stack[i]
    }
    throw new JMDParseError(
      'malformed_heading',
      'No enclosing scope for depth ' + depth,
      lineNo,
    )
  }

  function parentContainerAndSeen(scope) {
    if (scope.kind === 'object') {
      return { container: scope.container, seen: scope.seen }
    }
    if (scope.kind === 'array' && scope.currentItem) {
      if (scope.itemSeen === null) scope.itemSeen = new Map()
      return { container: scope.currentItem, seen: scope.itemSeen }
    }
    throw new JMDParseError(
      'malformed_heading',
      'Heading inside an array scope needs an active item',
      lineNo,
    )
  }

  function checkScalar(seen, key, kind) {
    if (!seen) return
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new JMDParseError(
        'repeated_scalar_key',
        'Key "' + key + '" repeated',
        lineNo,
      )
    }
    seen.set(key, kind)
  }

  function popToDepth(targetDepth) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= targetDepth) {
      popScope()
    }
  }

  function popScope() {
    const s = stack.pop()
    if (s.kind === 'array') {
      closeItem(s)
      emit('array_end', s.depth === 1 ? {} : { key: keyOfScope(s) })
    } else {
      emit('object_end', { key: keyOfScope(s) })
    }
  }

  function closeItem(arrayScope) {
    if (arrayScope.currentItem !== null) {
      emit('item_end')
      arrayScope.currentItem = null
      arrayScope.itemSeen = null
    }
  }

  // The parent container holds the scope's container under a known key;
  // look it up once so end events can name what closed.
  function keyOfScope(scope) {
    // Walk the stack below; find the container that holds scope.container.
    // Micro-inefficient but runs once per pop — fine for now.
    for (let i = stack.length - 1; i >= 0; i--) {
      const parent = stack[i]
      const bag = parent.kind === 'array' && parent.currentItem
        ? parent.currentItem
        : parent.container
      if (Array.isArray(bag)) {
        // Promoted array: search every parent dict in the bag for the
        // container reference (rare path; small N).
        continue
      }
      for (const k of Object.keys(bag)) {
        if (bag[k] === scope.container) return k
        // §7.4 promoted: parent[k] may be an array containing scope.container.
        if (Array.isArray(bag[k])
            && bag[k][bag[k].length - 1] === scope.container) {
          return k
        }
      }
    }
    return undefined
  }

  // --- Bare fields ---------------------------------------------------------

  function onField(line) {
    const f = parseField(line)
    if (!f) {
      throw new JMDParseError(
        'malformed_field',
        'Malformed field line',
        lineNo,
      )
    }
    const top = stack[stack.length - 1]
    let target, seen
    if (top.kind === 'object') {
      target = top.container
      seen = top.seen
    } else {
      if (!top.currentItem) {
        throw new JMDParseError(
          'malformed_field',
          'Bare field inside array scope without an item',
          lineNo,
        )
      }
      target = top.currentItem
      if (top.itemSeen === null) top.itemSeen = new Map()
      seen = top.itemSeen
    }
    checkScalar(seen, f.key, K_SCALAR_BARE)
    if (f.empty) {
      startBlockquote(target, f.key)
      return
    }
    if (f.block) {
      startBlock(target, f.key, f.block)
      return
    }
    target[f.key] = f.value
    emit('field', { key: f.key, value: f.value })
  }

  // --- Array items ---------------------------------------------------------

  function onDepthQualifiedItem(headingDepth, text) {
    // Find target: innermost array at depth == headingDepth wins (§8.6a).
    // Else fall back to array at depth == headingDepth - 1 (§8.6b — the
    // LLM-natural pattern of writing items one heading-level under the
    // array heading).
    let sameDepthIdx = -1
    let parentDepthIdx = -1
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]
      if (s.kind !== 'array') continue
      if (sameDepthIdx === -1 && s.depth === headingDepth) sameDepthIdx = i
      if (parentDepthIdx === -1 && s.depth === headingDepth - 1) {
        parentDepthIdx = i
      }
    }
    const targetIdx = sameDepthIdx !== -1 ? sameDepthIdx : parentDepthIdx
    if (targetIdx === -1) {
      throw new JMDParseError(
        'malformed_heading',
        'Depth-qualified item has no matching array scope',
        lineNo,
      )
    }
    // Close any scopes nested inside the target array.
    while (stack.length - 1 > targetIdx) popScope()
    // Reuse the regular item handler with the target array on top.
    onItem(text)
  }

  function onItem(line) {
    const top = stack[stack.length - 1]
    if (top.kind !== 'array') {
      throw new JMDParseError(
        'malformed_item',
        'Array item outside array scope',
        lineNo,
      )
    }

    closeItem(top)
    const rest = line === '-' ? '' : line.slice(2)

    if (rest === '') {
      const item = {}
      top.container.push(item)
      top.currentItem = item
      top.itemSeen = new Map()
      emit('item_start')
      return
    }

    const f = parseField(rest)
    if (f) {
      const item = {}
      top.container.push(item)
      top.currentItem = item
      top.itemSeen = new Map()
      top.itemSeen.set(f.key, K_SCALAR_BARE)
      emit('item_start')
      if (f.empty) {
        startBlockquote(item, f.key)
      } else if (f.block) {
        startBlock(item, f.key, f.block)
      } else {
        item[f.key] = f.value
        emit('field', { key: f.key, value: f.value })
      }
      return
    }

    const value = parseScalar(rest)
    top.container.push(value)
    top.currentItem = null
    top.itemSeen = null
    emit('item_value', { value })
  }

  function onIndented(line) {
    const content = line.replace(/^\s+/, '')
    const top = stack[stack.length - 1]
    if (top.kind !== 'array' || !top.currentItem) {
      throw new JMDParseError(
        'malformed_field',
        'Indented continuation without an active array item',
        lineNo,
      )
    }
    const f = parseField(content)
    if (!f) {
      throw new JMDParseError(
        'malformed_field',
        'Malformed indented continuation',
        lineNo,
      )
    }
    if (top.itemSeen === null) top.itemSeen = new Map()
    checkScalar(top.itemSeen, f.key, K_SCALAR_BARE)
    if (f.empty) {
      startBlockquote(top.currentItem, f.key)
      return
    }
    if (f.block) {
      startBlock(top.currentItem, f.key, f.block)
      return
    }
    top.currentItem[f.key] = f.value
    emit('field', { key: f.key, value: f.value })
  }

  // --- Finalization --------------------------------------------------------

  function finish() {
    if (block !== null) commitBlock()
    if (bq !== null) commitBlockquote()
    if (!seenRoot) {
      throw new JMDParseError(
        'malformed_root',
        'Document contained no root heading',
        lineNo,
      )
    }
    while (stack.length > 0) popScope()
    emit('document_end')
    return drain()
  }

  // --- Public surface ------------------------------------------------------

  function parse(text) {
    // A trailing newline is a line terminator, not a blank line — drop
    // any empty final element from the split.
    const lines = text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) processLine(line)
    finish()
    // frontmatterStarted is internal — keep the public shape unchanged.
    void frontmatterStarted
    return { mode, label, frontmatter, value: root }
  }

  async function* events(source) {
    for await (const line of source) {
      for (const ev of processLine(line)) yield ev
    }
    for (const ev of finish()) yield ev
  }

  return { processLine, finish, parse, events }
}

export function parse(text) {
  return createParser().parse(text)
}

// Line adapter: turn an async iterable of arbitrary string chunks (e.g. a
// fetch response body stream) into an async iterable of lines. Trailing
// `\r` is stripped; the final line is emitted even if unterminated.
export async function* toLines(source) {
  let buffer = ''
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : String(chunk)
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
    }
  }
  if (buffer !== '') yield buffer.replace(/\r$/, '')
}
