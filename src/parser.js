// JMD parser.
//
// The parser processes a JMD document line by line, maintaining a scope
// stack driven by heading depth. It builds a JavaScript value — an object
// or an array — from the resulting structure.
//
// Design notes:
//   - Stateful via closure (no class).
//   - Line-oriented: each line is a complete unit that updates the state.
//     This is the substrate that will eventually feed an async-generator
//     streaming surface; for now the public entry point is a batch `parse`.
//   - Parser-tolerant (§22.1): accepts anonymous headings and cosmetic
//     blank lines without complaint. Intentional generator output
//     (serialize) is strict; what we see here is what LLMs actually write.

import { parseScalar, parseKey, parseField } from './value.js'

// A heading begins with one or more `#`. At the root, a mode marker
// (`!`, `?`, `-`) may immediately follow with no intervening space.
// Everything after an optional separating space is the label.
const HEADING = /^(#+)([!?-])?(?:\s+(.*))?$/

export function createParser() {
  let lineNo = 0

  // Document-level state.
  let mode = null                  // 'data' | 'schema' | 'query' | 'delete'
  let label = null                 // root label (after mode prefix)
  const frontmatter = {}
  let inFrontmatter = true
  let seenRoot = false
  let root = null                  // the object or array being built

  // Scope stack. Each entry describes an open container.
  //   { kind: 'object' | 'array', container, depth }
  // Depth is the heading depth that opened the scope (root = 1).
  // Within an array scope, `currentItem` holds the object for the most
  // recent `-` line so indented continuation fields can attach to it.
  let stack = []

  // Pending blockquote (multiline value). When a `key:` line (empty value)
  // appears, we suspend the field and accumulate subsequent `> ` lines.
  // On the first non-`>` line, the accumulated content is committed.
  let bq = null  // { container, key, lines }

  // --- Line processing -----------------------------------------------------

  function processLine(rawLine) {
    lineNo++
    const line = rawLine.replace(/\r$/, '')

    if (bq !== null) {
      if (line === '>' || line.startsWith('> ')) {
        bq.lines.push(line === '>' ? '' : line.slice(2))
        return
      }
      commitBlockquote()
      // Fall through: the current line is an ordinary line in the new context.
    }

    if (/^\s*$/.test(line)) return onBlank()

    const h = HEADING.exec(line)
    if (h) return onHeading(h[1].length, h[2] || '', h[3] || '')

    if (inFrontmatter) return onFrontmatter(line)

    if (/^\s{2,}/.test(line)) return onIndented(line)

    if (line === '-' || line.startsWith('- ')) return onItem(line)

    return onField(line)
  }

  // --- Blockquote ----------------------------------------------------------

  function startBlockquote(container, key) {
    bq = { container, key, lines: [] }
  }

  function commitBlockquote() {
    bq.container[bq.key] = bq.lines.join('\n')
    bq = null
  }

  // --- Root / frontmatter --------------------------------------------------

  function onFrontmatter(line) {
    // `key: value` or bare `key` (flag-style frontmatter).
    const f = parseField(line)
    if (f) {
      frontmatter[f.key] = f.empty ? true : f.value
      return
    }
    const pk = parseKey(line)
    if (pk && pk.rest === '') {
      frontmatter[pk.key] = true
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
      stack = [{ kind: 'array', container: root, depth: 1 }]
    } else {
      label = text  // may be empty — anonymous root is permitted (§3.2a).
      root = {}
      stack = [{ kind: 'object', container: root, depth: 1 }]
    }
  }

  // --- Headings ------------------------------------------------------------

  function onHeading(depth, modeMark, text) {
    if (!seenRoot) {
      if (depth !== 1) throw parseError('Document must begin with a depth-1 heading')
      openRoot(modeMark, text)
      return
    }
    if (modeMark) {
      throw parseError('Mode markers (!, ?, -) are only valid on the root heading')
    }

    // Pop all scopes at or deeper than this heading.
    popToDepth(depth)

    // Headings inside scope — dispatched by label form.
    if (text === '' || text === undefined) {
      // Anonymous sub-heading at depth N. We treat it as an empty-label
      // object heading attached under the current scope with key "".
      return openObjectScope(depth, '')
    }

    // Depth-qualified array item: `## -` or `## - key: val`.
    // (Deferred: full support is planned for 0.2.0; here we reject.)
    if (text === '-' || text.startsWith('- ')) {
      throw parseError('Depth-qualified array items (## -) are not yet supported')
    }

    // Anonymous sub-array: `## []`.
    if (text === '[]') {
      throw parseError('Anonymous sub-array headings (## []) are not yet supported')
    }

    // `key[]` — array heading.
    if (text.endsWith('[]')) {
      const keyText = text.slice(0, -2)
      const pk = parseKey(keyText)
      if (!pk || pk.rest !== '') {
        throw parseError('Malformed array heading key')
      }
      return openArrayScope(depth, pk.key)
    }

    // `key: value` — scalar heading (terminal).
    const field = parseField(text)
    if (field && !field.empty) {
      const parent = parentObjectAt(depth)
      parent[field.key] = field.value
      return
    }

    // `key:` — scalar heading opening a multiline blockquote.
    if (field && field.empty) {
      const parent = parentObjectAt(depth)
      startBlockquote(parent, field.key)
      return
    }

    // `key` — object heading.
    const pk = parseKey(text)
    if (pk && pk.rest === '') {
      return openObjectScope(depth, pk.key)
    }

    throw parseError('Malformed heading')
  }

  function openObjectScope(depth, key) {
    const parent = parentObjectAt(depth)
    const obj = {}
    parent[key] = obj
    stack.push({ kind: 'object', container: obj, depth })
  }

  function openArrayScope(depth, key) {
    const parent = parentObjectAt(depth)
    const arr = []
    parent[key] = arr
    stack.push({ kind: 'array', container: arr, depth, currentItem: null })
  }

  // Find the object into which a scope or field at `depth` should be placed.
  function parentObjectAt(depth) {
    // Pop anything deeper than or equal to target (already done by caller),
    // then the top scope is the parent. It must be an object.
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
      stack.pop()
    }
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
  }

  // --- Array items ---------------------------------------------------------

  function onItem(line) {
    const top = stack[stack.length - 1]
    if (top.kind !== 'array') {
      throw parseError('Array item outside array scope')
    }
    const rest = line === '-' ? '' : line.slice(2)

    if (rest === '') {
      // `-` on its own: object item, fields follow on indented lines.
      const item = {}
      top.container.push(item)
      top.currentItem = item
      return
    }

    const f = parseField(rest)
    if (f) {
      const item = {}
      if (!f.empty) item[f.key] = f.value
      else {
        // `- key:` starts a blockquote for `key` in a new object item.
        top.container.push(item)
        top.currentItem = item
        startBlockquote(item, f.key)
        return
      }
      top.container.push(item)
      top.currentItem = item
      return
    }

    // Scalar item.
    top.container.push(parseScalar(rest))
    top.currentItem = null
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
  }

  // --- Blank lines ---------------------------------------------------------

  function onBlank() {
    // §7.2a: reset scope to root. Keep only the root scope on the stack.
    while (stack.length > 1) stack.pop()
    // Clear array-item tracking on the root if it is an array scope.
    if (stack[0] && stack[0].kind === 'array') stack[0].currentItem = null
  }

  // --- Finalization --------------------------------------------------------

  function finish() {
    if (bq !== null) commitBlockquote()
    if (!seenRoot) {
      throw parseError('Document contained no root heading')
    }
    return { mode, label, frontmatter, value: root }
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
    const lines = text.split('\n')
    for (const line of lines) processLine(line)
    return finish()
  }

  return { processLine, finish, parse }
}

export function parse(text) {
  return createParser().parse(text)
}
