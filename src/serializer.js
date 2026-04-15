// JMD serializer.
//
// Two surfaces over one implementation:
//
//   - serializeLines(value, label, frontmatter)  — generator of lines with
//                                                  trailing newlines. Suitable
//                                                  for streaming to a transport.
//   - serialize(value, label, frontmatter)       — returns the full document
//                                                  as a single string.
//
// Generator-strict per §22.1: output matches the canonical form that a
// conforming parser will accept without relying on tolerance.

import { serializeScalar, serializeKey } from './value.js'

export function* serializeLines(value, label = '', frontmatter = null) {
  if (frontmatter && Object.keys(frontmatter).length > 0) {
    for (const [k, v] of Object.entries(frontmatter)) {
      if (v === true) yield serializeKey(k) + '\n'
      else yield serializeKey(k) + ': ' + serializeScalar(v) + '\n'
    }
    yield '\n'
  }

  if (Array.isArray(value)) {
    const rootLabel = label === '' ? '[]' : label + ' []'
    yield '# ' + rootLabel + '\n'
    yield* emitArrayBody(value, 2)
  } else if (value !== null && typeof value === 'object') {
    yield (label === '' ? '#' : '# ' + label) + '\n'
    yield* emitObjectBody(value, 2)
  } else {
    throw new TypeError('Root value must be an object or array')
  }
}

export function serialize(value, label = '', frontmatter = null) {
  let out = ''
  for (const line of serializeLines(value, label, frontmatter)) out += line
  return out
}

function* emitObjectBody(obj, depth) {
  // Scalars first, then nested — keeps bare fields at the top of the scope
  // and avoids needing scalar headings for scope return.
  const scalars = []
  const nested = []
  for (const [k, v] of Object.entries(obj)) {
    if (isNested(v)) nested.push([k, v])
    else scalars.push([k, v])
  }
  for (const [k, v] of scalars) yield* emitScalarField(k, v)
  for (const [k, v] of nested) yield* emitNested(k, v, depth)
}

function* emitScalarField(key, value) {
  const k = serializeKey(key)
  if (typeof value === 'string' && value.includes('\n')) {
    yield k + ':' + '\n'
    for (const ln of value.split('\n')) {
      yield (ln === '' ? '>' : '> ' + ln) + '\n'
    }
    return
  }
  yield k + ': ' + serializeScalar(value) + '\n'
}

function* emitNested(key, value, depth) {
  const prefix = '#'.repeat(depth) + ' '
  const k = serializeKey(key)
  if (Array.isArray(value)) {
    yield prefix + k + '[]' + '\n'
    yield* emitArrayBody(value, depth + 1)
    return
  }
  yield prefix + k + '\n'
  yield* emitObjectBody(value, depth + 1)
}

function* emitArrayBody(arr, depth) {
  for (const item of arr) {
    if (Array.isArray(item)) {
      // Sub-array: anonymous heading at depth.
      yield '#'.repeat(depth) + ' []' + '\n'
      yield* emitArrayBody(item, depth + 1)
      continue
    }
    if (item === null || typeof item !== 'object') {
      yield '- ' + serializeScalar(item) + '\n'
      continue
    }
    yield* emitObjectItem(item, depth)
  }
}

function* emitObjectItem(item, depth) {
  const entries = Object.entries(item)
  if (entries.length === 0) {
    yield '-' + '\n'
    return
  }
  let first = true
  const nested = []
  for (const [k, v] of entries) {
    if (isNested(v)) { nested.push([k, v]); continue }
    const prefix = first ? '- ' : '  '
    yield prefix + emitInlineKeyValue(k, v) + '\n'
    first = false
  }
  if (first) yield '-' + '\n'
  for (const [k, v] of nested) yield* emitNested(k, v, depth)
}

function emitInlineKeyValue(key, value) {
  const k = serializeKey(key)
  if (typeof value === 'string' && value.includes('\n')) {
    // Blockquote continuations inside item bodies are not yet expressible
    // cleanly; fall back to the JSON escape form (§9.2) for this value.
    return k + ': ' + JSON.stringify(value)
  }
  return k + ': ' + serializeScalar(value)
}

function isNested(v) {
  return v !== null && typeof v === 'object'
}
