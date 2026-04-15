// JMD serializer.
//
// Two surfaces over one implementation:
//
//   - serializeLines(value, label, frontmatter)  — generator of lines with
//                                                  trailing newlines. Suitable
//                                                  for streaming to a transport.
//   - serialize(value, label, frontmatter)       — returns the full document
//                                                  as a single string (no
//                                                  trailing newline), matching
//                                                  the byte form emitted by
//                                                  the jmd-format Python
//                                                  reference implementation.
//
// Generator-strict per §22.1: output matches the canonical form that a
// conforming parser accepts without tolerance.

import { serializeScalar, serializeKey } from './value.js'

export function serialize(value, label = 'Document', frontmatter = null) {
  const lines = []
  emitDocument(value, label, frontmatter, lines)
  return lines.join('\n')
}

export function* serializeLines(value, label = 'Document', frontmatter = null) {
  const lines = []
  emitDocument(value, label, frontmatter, lines)
  for (const ln of lines) yield ln + '\n'
}

// Mode markers attach directly to `#` in the root heading: `#- Order`,
// `#? Order`, `#! Order`. Callers pass the mark as a `- `, `? ` or `! `
// prefix on `label`; the serializer attaches it to `#` without a space
// between them. Plain data documents (no prefix) emit `# Label`.
function splitLabel(label) {
  if (label.length >= 2
      && (label[0] === '-' || label[0] === '?' || label[0] === '!')
      && label[1] === ' ') {
    return { mark: label[0], rest: label.slice(2) }
  }
  return { mark: '', rest: label }
}

function emitDocument(value, label, frontmatter, lines) {
  if (frontmatter && Object.keys(frontmatter).length > 0) {
    for (const [k, v] of Object.entries(frontmatter)) {
      if (v === true) lines.push(serializeKey(k))
      else lines.push(serializeKey(k) + ': ' + serializeScalar(v))
    }
    lines.push('')
  }

  const { mark, rest } = splitLabel(label)
  const prefix = '#' + mark + ' '

  if (Array.isArray(value)) {
    const head = rest === '[]' ? prefix + '[]' : prefix + rest + '[]'
    lines.push(head)
    writeArrayItems(value, lines, 1)
  } else if (value !== null && typeof value === 'object') {
    lines.push(prefix + rest)
    writeObjectFields(value, lines, 1)
  } else {
    throw new TypeError('Root value must be an object or array')
  }
}

function heading(depth) {
  return '#'.repeat(depth) + ' '
}

function writeMultiline(value, lines) {
  for (const part of value.split('\n')) {
    lines.push(part === '' ? '>' : '> ' + part)
  }
}

function writeObjectFields(obj, lines, depth) {
  let needsHeading = false
  for (const [key, value] of Object.entries(obj)) {
    const k = serializeKey(key)
    if (isPlainObject(value)) {
      lines.push('')
      lines.push(heading(depth + 1) + k)
      writeObjectFields(value, lines, depth + 1)
      needsHeading = true
    } else if (Array.isArray(value)) {
      lines.push('')
      lines.push(heading(depth + 1) + k + '[]')
      writeArrayItems(value, lines, depth + 1)
      needsHeading = true
    } else if (typeof value === 'string' && value.includes('\n')) {
      lines.push((needsHeading ? heading(depth + 1) : '') + k + ':')
      writeMultiline(value, lines)
      needsHeading = true
    } else if (needsHeading) {
      lines.push(heading(depth + 1) + k + ': ' + serializeScalar(value))
    } else {
      lines.push(k + ': ' + serializeScalar(value))
    }
  }
}

function writeArrayItems(lst, lines, depth) {
  if (lst.length === 0) return

  const allLists = lst.every(i => Array.isArray(i))
  const allDicts = lst.every(isPlainObject)
  const allScalars = lst.every(i => !isNested(i))

  if (allLists) {
    for (const item of lst) {
      lines.push(heading(depth + 1) + '[]')
      writeArrayItems(item, lines, depth + 1)
    }
    return
  }

  if (allDicts) {
    const hasNested = lst.some(item =>
      Object.values(item).some(isNested))
    for (let i = 0; i < lst.length; i++) {
      writeDictItem(lst[i], lines, depth, i > 0 && hasNested)
    }
    return
  }

  if (allScalars) {
    for (const item of lst) {
      lines.push('- ' + serializeScalar(item))
    }
    return
  }

  // Heterogeneous array.
  //
  // The C-accelerated Python reference does not insert thematic breaks
  // inside a heterogeneous array — items simply follow one another. We
  // match that form byte-for-byte.
  for (const item of lst) {
    if (isPlainObject(item)) {
      writeDictItem(item, lines, depth, false)
    } else if (Array.isArray(item)) {
      lines.push(heading(depth + 1) + '[]')
      writeArrayItems(item, lines, depth + 1)
    } else {
      lines.push('- ' + serializeScalar(item))
    }
  }
}

function writeDictItem(item, lines, depth, separatorNeeded) {
  const scalarFields = []
  const nestedFields = []
  for (const [k, v] of Object.entries(item)) {
    if (isNested(v)) nestedFields.push([k, v])
    else scalarFields.push([k, v])
  }

  if (separatorNeeded) {
    // Match the C-accelerated Python serializer (the default in jmd-format):
    // blank line before the `---`, but the next `- ` follows immediately on
    // the next line — no blank after the thematic break.
    lines.push('')
    lines.push('---')
  }

  if (scalarFields.length === 0) {
    lines.push('-')
  } else {
    let first = true
    for (const [k, v] of scalarFields) {
      const sv = serializeScalar(v)
      const qk = serializeKey(k)
      if (first) {
        lines.push('- ' + qk + ': ' + sv)
        first = false
      } else {
        lines.push('  ' + qk + ': ' + sv)
      }
    }
  }

  if (nestedFields.length > 0) {
    writeObjectFields(Object.fromEntries(nestedFields), lines, depth)
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNested(v) {
  return v !== null && typeof v === 'object'
}
