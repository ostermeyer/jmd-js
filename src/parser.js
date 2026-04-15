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

import { parseScalar, parseKey, parseField } from './value.js'

const HEADING = /^(#+)([!?-])?(?:\s+(.*))?$/

export function createParser() {
  let lineNo = 0

  // Document-level state.
  let mode = null
  let label = null
  const frontmatter = {}
  let inFrontmatter = true
  let seenRoot = false
  let root = null

  // Scope stack. Each entry:
  //   { kind: 'object' | 'array', container, depth, currentItem? }
  // currentItem lives on array scopes only and holds the object built by
  // the most recent `- ` line so indented continuations attach to it.
  let stack = []

  // Pending blockquote state.
  //   { container, key, lines }
  let bq = null

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

    if (bq !== null) {
      if (line === '>' || line.startsWith('> ')) {
        const content = line === '>' ? '' : line.slice(2)
        bq.lines.push(content)
        emit('field_content', { text: content })
        return drain()
      }
      commitBlockquote()
    }

    if (/^\s*$/.test(line)) { onBlank(); return drain() }

    const h = HEADING.exec(line)
    if (h) { onHeading(h[1].length, h[2] || '', h[3] || ''); return drain() }

    if (inFrontmatter) { onFrontmatter(line); return drain() }

    if (/^\s{2,}/.test(line)) { onIndented(line); return drain() }

    if (line === '-' || line.startsWith('- ')) { onItem(line); return drain() }

    onField(line)
    return drain()
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

  // --- Root / frontmatter --------------------------------------------------

  function onFrontmatter(line) {
    const f = parseField(line)
    if (f) {
      const v = f.empty ? true : f.value
      frontmatter[f.key] = v
      emit('frontmatter', { key: f.key, value: v })
      return
    }
    const pk = parseKey(line)
    if (pk && pk.rest === '') {
      frontmatter[pk.key] = true
      emit('frontmatter', { key: pk.key, value: true })
      return
    }
    throw parseError('Unexpected line before root heading')
  }

  function openRoot(modeMark, text) {
    inFrontmatter = false
    seenRoot = true

    if (modeMark === '!') mode = 'schema'
    else if (modeMark === '?') mode = 'query'
    else if (modeMark === '-') mode = 'delete'
    else mode = 'data'

    if (text === '[]') {
      label = ''
      root = []
      stack = [{ kind: 'array', container: root, depth: 1, currentItem: null }]
    } else {
      label = text
      root = {}
      stack = [{ kind: 'object', container: root, depth: 1 }]
    }
    emit('document_start', { mode, label })
  }

  // --- Headings ------------------------------------------------------------

  function onHeading(depth, modeMark, text) {
    if (!seenRoot) {
      if (depth !== 1) {
        throw parseError('Document must begin with a depth-1 heading')
      }
      openRoot(modeMark, text)
      return
    }
    if (modeMark) {
      throw parseError('Mode markers (!, ?, -) are only valid on the root heading')
    }

    popToDepth(depth)

    if (text === '' || text === undefined) {
      openObjectScope(depth, '')
      return
    }

    // Depth-qualified array item: `## -` or `## - key: val` — deferred.
    if (text === '-' || text.startsWith('- ')) {
      throw parseError('Depth-qualified array items (## -) are not yet supported')
    }

    // Anonymous sub-array: `### []` — handled below with the other array forms.
    if (text === '[]') {
      openSubArray(depth)
      return
    }

    if (text.endsWith('[]')) {
      const keyText = text.slice(0, -2)
      const pk = parseKey(keyText)
      if (!pk || pk.rest !== '') throw parseError('Malformed array heading key')
      openArrayScope(depth, pk.key)
      return
    }

    const field = parseField(text)
    if (field && !field.empty) {
      const parent = parentObjectAt(depth)
      parent[field.key] = field.value
      emit('field', { key: field.key, value: field.value })
      return
    }

    if (field && field.empty) {
      const parent = parentObjectAt(depth)
      startBlockquote(parent, field.key)
      return
    }

    const pk = parseKey(text)
    if (pk && pk.rest === '') {
      openObjectScope(depth, pk.key)
      return
    }

    throw parseError('Malformed heading')
  }

  function openObjectScope(depth, key) {
    const parent = parentObjectAt(depth)
    const obj = {}
    parent[key] = obj
    stack.push({ kind: 'object', container: obj, depth })
    emit('object_start', { key })
  }

  function openArrayScope(depth, key) {
    const parent = parentObjectAt(depth)
    const arr = []
    parent[key] = arr
    stack.push({ kind: 'array', container: arr, depth, currentItem: null })
    emit('array_start', { key })
  }

  function openSubArray(depth) {
    // `### []`: start a new anonymous array as the next item of the
    // enclosing array scope.
    const top = stack[stack.length - 1]
    if (!top || top.kind !== 'array') {
      throw parseError('Anonymous sub-array outside array scope')
    }
    closeItem(top)
    const inner = []
    top.container.push(inner)
    stack.push({ kind: 'array', container: inner, depth, currentItem: null })
    emit('array_start', {})
  }

  function parentObjectAt(depth) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]
      if (s.depth < depth) {
        if (s.kind === 'object') return s.container
        if (s.kind === 'array' && s.currentItem) return s.currentItem
        throw parseError('Field has no enclosing object scope')
      }
    }
    throw parseError('No enclosing scope for depth ' + depth)
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
      for (const k of Object.keys(bag)) {
        if (bag[k] === scope.container) return k
      }
    }
    return undefined
  }

  // --- Bare fields ---------------------------------------------------------

  function onField(line) {
    const f = parseField(line)
    if (!f) throw parseError('Malformed field line')
    const top = stack[stack.length - 1]
    const target = top.kind === 'object'
      ? top.container
      : (top.currentItem || throwHere('Bare field inside array scope without an item'))
    if (f.empty) {
      startBlockquote(target, f.key)
      return
    }
    target[f.key] = f.value
    emit('field', { key: f.key, value: f.value })
  }

  // --- Array items ---------------------------------------------------------

  function onItem(line) {
    const top = stack[stack.length - 1]
    if (top.kind !== 'array') throw parseError('Array item outside array scope')

    closeItem(top)
    const rest = line === '-' ? '' : line.slice(2)

    if (rest === '') {
      const item = {}
      top.container.push(item)
      top.currentItem = item
      emit('item_start')
      return
    }

    const f = parseField(rest)
    if (f) {
      const item = {}
      top.container.push(item)
      top.currentItem = item
      emit('item_start')
      if (f.empty) {
        startBlockquote(item, f.key)
      } else {
        item[f.key] = f.value
        emit('field', { key: f.key, value: f.value })
      }
      return
    }

    const value = parseScalar(rest)
    top.container.push(value)
    top.currentItem = null
    emit('item_value', { value })
  }

  function onIndented(line) {
    const content = line.replace(/^\s+/, '')
    const top = stack[stack.length - 1]
    if (top.kind !== 'array' || !top.currentItem) {
      throw parseError('Indented continuation without an active array item')
    }
    const f = parseField(content)
    if (!f) throw parseError('Malformed indented continuation')
    if (f.empty) {
      startBlockquote(top.currentItem, f.key)
      return
    }
    top.currentItem[f.key] = f.value
    emit('field', { key: f.key, value: f.value })
  }

  // --- Blank lines ---------------------------------------------------------

  function onBlank() {
    // Within an array body, a blank followed by `-` is cosmetic; we don't
    // have lookahead here, so we optimistically reset and accept it (the
    // next line either re-enters the scope via `-` at the right depth or
    // doesn't). Tolerance per §22.1.
    if (stack.length <= 1) return
    emit('scope_reset')
    while (stack.length > 1) popScope()
    if (stack[0] && stack[0].kind === 'array') closeItem(stack[0])
  }

  // --- Finalization --------------------------------------------------------

  function finish() {
    if (bq !== null) commitBlockquote()
    if (!seenRoot) {
      throw parseError('Document contained no root heading')
    }
    while (stack.length > 0) popScope()
    emit('document_end')
    return drain()
  }

  // --- Errors --------------------------------------------------------------

  function parseError(msg) {
    const err = new Error(msg + ' (line ' + lineNo + ')')
    err.line = lineNo
    return err
  }
  function throwHere(msg) { throw parseError(msg) }

  // --- Public surface ------------------------------------------------------

  function parse(text) {
    // A trailing newline is a line terminator, not a blank line — drop
    // any empty final element from the split.
    const lines = text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) processLine(line)
    finish()
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
