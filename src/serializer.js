// JMD serializer.
//
// Produces canonical JMD text from a JavaScript value. Generator-strict
// (§22.1): the output uses the forms a conforming parser expects without
// relying on tolerance.
//
// Multiline strings are emitted as blockquotes (§9.1); short strings stay
// inline. Frontmatter fields appear above the root heading.

import { serializeScalar, serializeKey } from './value.js'

// Serialize a JavaScript value as a JMD document.
//
//   value       — the data (object or array)
//   label       — the root label. Prefix with '!' / '?' / '-' to select
//                 schema / query / delete mode; otherwise data mode.
//   frontmatter — optional plain object of frontmatter fields.
//
// Returns a string ending in a newline.
export function serialize(value, label = '', frontmatter = null) {
  const out = []

  if (frontmatter && Object.keys(frontmatter).length > 0) {
    for (const [k, v] of Object.entries(frontmatter)) {
      if (v === true) {
        out.push(serializeKey(k))
      } else {
        out.push(serializeKey(k) + ': ' + serializeScalar(v))
      }
    }
    out.push('')
  }

  if (Array.isArray(value)) {
    const rootLabel = label === '' ? '[]' : label + ' []'
    out.push('# ' + rootLabel)
    writeArrayBody(out, value, 2)
  } else if (value !== null && typeof value === 'object') {
    out.push(label === '' ? '#' : '# ' + label)
    writeObjectBody(out, value, 2)
  } else {
    throw new TypeError('Root value must be an object or array')
  }

  return out.join('\n') + '\n'
}

function writeObjectBody(out, obj, depth) {
  // Two passes so scalars appear before nested structures — this matches
  // canonical output and avoids scope-return surprises.
  const scalars = []
  const nested = []
  for (const [k, v] of Object.entries(obj)) {
    if (isNested(v)) nested.push([k, v])
    else scalars.push([k, v])
  }
  for (const [k, v] of scalars) writeScalarField(out, k, v)
  for (const [k, v] of nested) writeNested(out, k, v, depth)
}

function writeScalarField(out, key, value) {
  const k = serializeKey(key)
  if (typeof value === 'string' && value.includes('\n')) {
    // Blockquote multiline form (§9.1).
    out.push(k + ':')
    for (const ln of value.split('\n')) {
      out.push(ln === '' ? '>' : '> ' + ln)
    }
    return
  }
  out.push(k + ': ' + serializeScalar(value))
}

function writeNested(out, key, value, depth) {
  const prefix = '#'.repeat(depth) + ' '
  const k = serializeKey(key)
  if (Array.isArray(value)) {
    out.push(prefix + k + '[]')
    writeArrayBody(out, value, depth + 1)
    return
  }
  out.push(prefix + k)
  writeObjectBody(out, value, depth + 1)
}

function writeArrayBody(out, arr, depth) {
  for (const item of arr) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      out.push('- ' + serializeScalar(item))
      continue
    }
    writeObjectItem(out, item, depth)
  }
}

function writeObjectItem(out, item, depth) {
  const entries = Object.entries(item)
  if (entries.length === 0) {
    out.push('-')
    return
  }
  // First scalar field on the `- ` line; subsequent scalars as indented
  // continuations; nested structures via headings at the item's depth.
  let first = true
  const nested = []
  for (const [k, v] of entries) {
    if (isNested(v)) {
      nested.push([k, v])
      continue
    }
    if (first) {
      out.push('- ' + serializeKeyValue(k, v))
      first = false
    } else {
      out.push('  ' + serializeKeyValue(k, v))
    }
  }
  if (first) {
    // No scalar fields — emit a bare `-` and let nested headings follow.
    out.push('-')
  }
  for (const [k, v] of nested) writeNested(out, k, v, depth)
}

function serializeKeyValue(key, value) {
  const k = serializeKey(key)
  if (typeof value === 'string' && value.includes('\n')) {
    // Indented continuations can't carry blockquotes cleanly in this
    // first cut; quote the value instead (JSON escape form, §9.2).
    return k + ': ' + JSON.stringify(value)
  }
  return k + ': ' + serializeScalar(value)
}

function isNested(v) {
  return v !== null && typeof v === 'object'
}
