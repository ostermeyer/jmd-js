// SPDX-License-Identifier: Apache-2.0
// Scalar values and keys.
//
// Parsing and serialization of the smallest JMD units: scalar values
// (null, booleans, numbers, strings) and field keys. These helpers are
// used by both parser and serializer, and stay at the character level —
// line structure and scope are handled one layer up.

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const BARE_KEY = /^[A-Za-z0-9_-]+/

// Parse the text that appears after `key: ` into a JS value.
// §2.1: bare values are tried as null, true, false, number; otherwise string.
export function parseScalar(raw) {
  if (raw === '') return ''
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (NUMBER.test(raw)) return Number(raw)
  if (raw.charCodeAt(0) === 34 /* " */) {
    // Quoted string — JSON semantics for escapes (§5, RFC 8259).
    return JSON.parse(raw)
  }
  return raw
}

// Serialize a scalar for use as a field value.
// §6.1: quote strings that would otherwise be misread (as type or structure).
export function serializeScalar(value) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot serialize non-finite number: ' + value)
    }
    return String(value)
  }
  if (typeof value === 'string') {
    return needsQuoting(value) ? JSON.stringify(value) : value
  }
  throw new TypeError('Cannot serialize scalar of type ' + typeof value)
}

function needsQuoting(s) {
  // Quoting rules matching the jmd-format Python reference:
  //   - empty string, ambiguous scalars, and numbers ⇒ always quote
  //   - structural prefixes (`# `, `- `) ⇒ quote
  //   - strings starting with `"` ⇒ quote (otherwise ambiguous with quoted form)
  //   - strings containing newline or tab ⇒ quote (JSON-escape line structure)
  //   - internal quotes and backslashes are left bare — the parser is
  //     tolerant enough to accept them, and Python's serializer does the same.
  if (s === '') return true
  if (s === 'null' || s === 'true' || s === 'false') return true
  if (NUMBER.test(s)) return true
  if (s === '-') return true
  if (s.startsWith('# ') || s.startsWith('- ')) return true
  if (s.charCodeAt(0) === 34 /* " */) return true
  if (/[\n\t]/.test(s)) return true
  return false
}

// Parse a bare or quoted key from the start of a string.
// Returns { key, rest } or null if no key is present.
export function parseKey(str) {
  if (str.charCodeAt(0) === 34 /* " */) {
    let i = 1
    while (i < str.length) {
      const c = str.charCodeAt(i)
      if (c === 92 /* \ */) { i += 2; continue }
      if (c === 34 /* " */) {
        const key = JSON.parse(str.slice(0, i + 1))
        return { key, rest: str.slice(i + 1) }
      }
      i++
    }
    return null
  }
  const m = BARE_KEY.exec(str)
  if (!m) return null
  return { key: m[0], rest: str.slice(m[0].length) }
}

// Serialize a key — bare if the character class permits, quoted otherwise.
export function serializeKey(key) {
  if (typeof key !== 'string') {
    throw new TypeError('Key must be a string, got ' + typeof key)
  }
  if (key.length > 0 && /^[A-Za-z0-9_-]+$/.test(key)) return key
  return JSON.stringify(key)
}

// Parse `key: value` or `key:` (empty value).
// Returns { key, value } or { key, empty: true } or null.
export function parseField(line) {
  const pk = parseKey(line)
  if (!pk) return null
  const rest = pk.rest
  if (rest.length === 0) return null
  if (rest.charCodeAt(0) !== 58 /* : */) return null
  const after = rest.slice(1)
  if (after === '' || /^\s*$/.test(after)) {
    return { key: pk.key, empty: true }
  }
  if (after.charCodeAt(0) !== 32 /* space */) return null
  return { key: pk.key, value: parseScalar(after.slice(1)) }
}
