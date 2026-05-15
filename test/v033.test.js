// SPDX-License-Identifier: Apache-2.0
// JMD spec v0.3.3 — feature and bug coverage.
//
// Tracks parity with jmd-impl/tests/test_v033.py:
//   - §7.4 repeated headings as implicit arrays + three structured errors
//   - §3.5.1 frontmatter `---` marker tolerance
//   - §5.2 multi-line block scalars (`|` literal, `>` folded)
//   - D11 serializer label validation
//   - D12 multi-line frontmatter as blockquote (round-trip)
//   - D13 blockquote leading-newline round-trip

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parse,
  serialize,
  validateLabel,
  JMDParseError,
} from '../src/index.js'

// --- §7.4: implicit-array promotion ----------------------------------------

test('§7.4: two repeated ## Op headings promote to a 2-element array', () => {
  const { value } = parse('# Doc\n## Op\ntype: rect\n## Op\ntype: text\n')
  assert.deepEqual(value, {
    Op: [{ type: 'rect' }, { type: 'text' }],
  })
})

test('§7.4: third repeated ## Op extends the promoted array', () => {
  const src = '# Doc\n## Op\ntype: rect\n## Op\ntype: text\n## Op\ntype: path\n'
  const { value } = parse(src)
  assert.deepEqual(value, {
    Op: [{ type: 'rect' }, { type: 'text' }, { type: 'path' }],
  })
})

test('§7.4: single ## Op without [] stays an object', () => {
  const { value } = parse('# Doc\n## Op\ntype: rect\n')
  assert.deepEqual(value, { Op: { type: 'rect' } })
})

test('§7.4: nested repeated ### row inside ## table promotes', () => {
  const src = [
    '# Doc',
    '## table',
    '### row', 'h: 32',
    '### row', 'h: 28',
  ].join('\n')
  const { value } = parse(src)
  assert.deepEqual(value, {
    table: { row: [{ h: 32 }, { h: 28 }] },
  })
})

// --- §7.4: three structured error kinds ------------------------------------

test('§7.4: ## Op then ## Op[] raises sigil_conflict', () => {
  try {
    parse('# Doc\n## Op\ntype: rect\n## Op[]\n- type: text\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'sigil_conflict')
  }
})

test('§7.4: ## Op[] then ## Op also raises sigil_conflict', () => {
  try {
    parse('# Doc\n## Op[]\n- type: rect\n## Op\ntype: text\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'sigil_conflict')
  }
})

test('§7.4: two ## Op[] sections raise repeated_explicit_array', () => {
  try {
    parse('# Doc\n## Op[]\n- type: rect\n## Op[]\n- type: text\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'repeated_explicit_array')
  }
})

test('§7.4: two bare x: ... lines raise repeated_scalar_key', () => {
  try {
    parse('# Doc\nx: 1\nx: 2\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'repeated_scalar_key')
  }
})

test('§7.4: two ## x: ... scalar headings raise repeated_scalar_key', () => {
  try {
    parse('# Doc\n## x: 1\n## x: 2\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'repeated_scalar_key')
  }
})

test('§7.4: bare then heading form raises repeated_scalar_key', () => {
  try {
    parse('# Doc\nx: 1\n## x: 2\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'repeated_scalar_key')
  }
})

test('§7.4: bare x: 1 then ## x object heading raises repeated_scalar_key', () => {
  try {
    parse('# Doc\nx: 1\n## x\ny: 5\n')
    assert.fail('expected JMDParseError')
  } catch (err) {
    assert.ok(err instanceof JMDParseError)
    assert.equal(err.kind, 'repeated_scalar_key')
  }
})

// --- §3.5.1: frontmatter `---` marker tolerance ---------------------------

test('§3.5.1: --- marker before frontmatter is consumed', () => {
  const { frontmatter, value } = parse(
    '---\nconfidence: high\n\n# Doc\nx: 1\n',
  )
  assert.deepEqual(frontmatter, { confidence: 'high' })
  assert.deepEqual(value, { x: 1 })
})

test('§3.5.1: --- marker after frontmatter is consumed', () => {
  const { frontmatter, value } = parse(
    'confidence: high\n---\n# Doc\nx: 1\n',
  )
  assert.deepEqual(frontmatter, { confidence: 'high' })
  assert.deepEqual(value, { x: 1 })
})

test('§3.5.1: markers on both sides equal plain form', () => {
  const wrapped = parse(
    '---\nconfidence: high\nsource: db\n---\n\n# Doc\nx: 1\n',
  ).frontmatter
  const plain = parse(
    'confidence: high\nsource: db\n\n# Doc\nx: 1\n',
  ).frontmatter
  assert.deepEqual(wrapped, plain)
  assert.deepEqual(wrapped, { confidence: 'high', source: 'db' })
})

test('§3.5.1: ---- and ----- are also tolerated', () => {
  const { frontmatter, value } = parse(
    '----\nconfidence: high\n-----\n# Doc\nx: 1\n',
  )
  assert.deepEqual(frontmatter, { confidence: 'high' })
  assert.deepEqual(value, { x: 1 })
})

// --- §5.2: block scalars (literal | and folded >) -------------------------

test('§5.2 literal: bare key: | joins lines with newline', () => {
  const { value } = parse('# Doc\nbio: |\n  line one\n  line two\n')
  assert.deepEqual(value, { bio: 'line one\nline two' })
})

test('§5.2 literal: ## key: | opens block scalar at heading position', () => {
  const { value } = parse('# Doc\n## bio: |\n  alpha\n  beta\n')
  assert.deepEqual(value, { bio: 'alpha\nbeta' })
})

test('§5.2 literal: trailing blank line is dropped', () => {
  const { value } = parse('# Doc\nbio: |\n  one\n  \n')
  assert.deepEqual(value, { bio: 'one' })
})

test('§5.2 folded: bare key: > joins lines with single space', () => {
  const { value } = parse('# Doc\nbio: >\n  line one\n  line two\n')
  assert.deepEqual(value, { bio: 'line one line two' })
})

test('§5.2 folded: ## key: > folds at heading position', () => {
  const { value } = parse('# Doc\n## bio: >\n  alpha\n  beta\n')
  assert.deepEqual(value, { bio: 'alpha beta' })
})

test('§5.2 folded: one blank line between groups becomes one newline', () => {
  const { value } = parse('# Doc\nbio: >\n  a\n\n  b\n')
  assert.deepEqual(value, { bio: 'a\nb' })
})

test('§5.2 folded: two blank lines preserve two newlines', () => {
  const { value } = parse('# Doc\nbio: >\n  a\n\n\n  b\n')
  assert.deepEqual(value, { bio: 'a\n\nb' })
})

// --- D11: serializer label validation -------------------------------------

test('D11: label with \\n raises RangeError', () => {
  assert.throws(
    () => serialize({ x: 1 }, 'foo\nbar'),
    { name: 'RangeError' },
  )
})

test('D11: label with \\r raises RangeError', () => {
  assert.throws(
    () => serialize({ x: 1 }, 'foo\rbar'),
    { name: 'RangeError' },
  )
})

test('D11: surrounding whitespace is silently stripped', () => {
  assert.equal(serialize({ x: 1 }, '  Order  '), '# Order\nx: 1')
})

test('D11: mode prefix survives surrounding whitespace strip', () => {
  assert.equal(serialize({ x: 1 }, '  ? Tasks  '), '#? Tasks\nx: 1')
})

test('D11: anonymous delete root array via "- "', () => {
  assert.equal(serialize([], '- '), '#- []')
})

test('D11: validateLabel is exported and idempotent on clean input', () => {
  assert.equal(validateLabel('Order'), 'Order')
  assert.equal(validateLabel('? Tasks'), '? Tasks')
})

// --- D12: multi-line frontmatter ------------------------------------------

test('D12: multi-line frontmatter value round-trips through blockquote', () => {
  const fm = { summary: 'line one\nline two', page: 1 }
  const s = serialize({ id: 42 }, 'Order', fm)
  const { frontmatter, value } = parse(s)
  assert.deepEqual(value, { id: 42 })
  assert.deepEqual(frontmatter, fm)
})

test('D12: multi-line frontmatter serialized form uses key:\\n> line blockquote', () => {
  const fm = { note: 'a\nb' }
  const s = serialize({ x: 1 }, 'T', fm)
  assert.ok(s.includes('note:\n> a\n> b'), 'expected blockquote form, got: ' + s)
})

test('D12: leading-newline frontmatter value is lossless', () => {
  const fm = { note: '\nfollows' }
  const s = serialize({ x: 1 }, 'T', fm)
  const { frontmatter } = parse(s)
  assert.deepEqual(frontmatter, fm)
})

// --- D13: blockquote leading-newline round-trip ---------------------------

test('D13: \\nfoo body value survives serialize → parse', () => {
  const v = '\nfoo'
  const s = serialize({ x: v }, 'T')
  assert.deepEqual(parse(s).value, { x: v })
})

test('D13: internal blank lines in blockquote value round-trip', () => {
  const v = 'a\n\nb'
  const s = serialize({ x: v }, 'T')
  assert.deepEqual(parse(s).value, { x: v })
})
