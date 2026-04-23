// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, serialize } from '../src/index.js'

test('parses a minimal data document', () => {
  const { mode, label, value } = parse('# Order\nid: 42\nstatus: pending\n')
  assert.equal(mode, 'data')
  assert.equal(label, 'Order')
  assert.deepEqual(value, { id: 42, status: 'pending' })
})

test('parses scalar types correctly', () => {
  const { value } = parse([
    '# Types',
    'n: 42',
    'f: 3.14',
    'neg: -7',
    'exp: 1e10',
    'b_true: true',
    'b_false: false',
    'nil: null',
    'str: hello',
    'quoted: "42"',
    'escaped: "line\\nbreak"'
  ].join('\n'))
  assert.deepEqual(value, {
    n: 42, f: 3.14, neg: -7, exp: 1e10,
    b_true: true, b_false: false, nil: null,
    str: 'hello', quoted: '42', escaped: 'line\nbreak'
  })
})

test('parses nested objects via headings', () => {
  const { value } = parse([
    '# Order',
    'id: 42',
    '## address',
    'street: Hauptstraße 1',
    'city: Berlin',
    '### geo',
    'lat: 52.52',
    'lng: 13.40'
  ].join('\n'))
  assert.deepEqual(value, {
    id: 42,
    address: {
      street: 'Hauptstraße 1',
      city: 'Berlin',
      geo: { lat: 52.52, lng: 13.40 }
    }
  })
})

test('blank line resets scope to root', () => {
  const { value } = parse([
    '# Order',
    'id: 42',
    '## address',
    'city: Berlin',
    '',
    'total: 84.99'
  ].join('\n'))
  assert.deepEqual(value, {
    id: 42,
    address: { city: 'Berlin' },
    total: 84.99
  })
})

test('parses arrays of scalars', () => {
  const { value } = parse([
    '# Order',
    '## tags[]',
    '- express',
    '- fragile',
    '- "404"'
  ].join('\n'))
  assert.deepEqual(value, { tags: ['express', 'fragile', '404'] })
})

test('parses arrays of objects with indented continuations', () => {
  const { value } = parse([
    '# Order',
    '## items[]',
    '- sku: A1',
    '  qty: 2',
    '  price: 29.99',
    '- sku: B3',
    '  qty: 1',
    '  price: 24.99'
  ].join('\n'))
  assert.deepEqual(value, {
    items: [
      { sku: 'A1', qty: 2, price: 29.99 },
      { sku: 'B3', qty: 1, price: 24.99 }
    ]
  })
})

test('parses blockquote multiline strings', () => {
  const { value } = parse([
    '# Article',
    'title: Demo',
    'body:',
    '> First paragraph with **bold**.',
    '>',
    '> Second paragraph.'
  ].join('\n'))
  assert.equal(value.title, 'Demo')
  assert.equal(value.body, 'First paragraph with **bold**.\n\nSecond paragraph.')
})

test('parses frontmatter', () => {
  const { frontmatter, value } = parse([
    'page: 1',
    'page-size: 50',
    'count',
    '',
    '# Orders',
    'status: active'
  ].join('\n'))
  assert.equal(frontmatter.page, 1)
  assert.equal(frontmatter['page-size'], 50)
  assert.equal(frontmatter.count, true)
  assert.deepEqual(value, { status: 'active' })
})

test('recognizes all four root modes', () => {
  assert.equal(parse('# Order\n').mode, 'data')
  assert.equal(parse('#! Order\n').mode, 'schema')
  assert.equal(parse('#? Order\n').mode, 'query')
  assert.equal(parse('#- Order\nid: 42\n').mode, 'delete')
})

test('recognizes root array', () => {
  const { value } = parse('# []\n- 1\n- 2\n- 3\n')
  assert.deepEqual(value, [1, 2, 3])
})

test('scalar heading closes deeper scope', () => {
  const { value } = parse([
    '# Order',
    'id: 42',
    '## address',
    'city: Berlin',
    '## total: 84.99'
  ].join('\n'))
  assert.deepEqual(value, {
    id: 42,
    address: { city: 'Berlin' },
    total: 84.99
  })
})

test('reports line number on parse error', () => {
  try {
    parse('# Order\nid: 42\n- orphan\n')
    assert.fail('expected throw')
  } catch (e) {
    assert.equal(e.line, 3)
  }
})

// --- Serializer tests ----------------------------------------------------

test('serializes a minimal data document', () => {
  const out = serialize({ id: 42, status: 'pending' }, 'Order')
  assert.equal(out, '# Order\nid: 42\nstatus: pending')
})

test('quotes strings that would otherwise be misread', () => {
  const out = serialize({ code: '42', flag: 'true', empty: '' }, 'X')
  assert.match(out, /code: "42"/)
  assert.match(out, /flag: "true"/)
  assert.match(out, /empty: ""/)
})

test('serializes nested objects as headings', () => {
  const out = serialize(
    { id: 42, address: { city: 'Berlin', zip: '10115' } },
    'Order'
  )
  assert.equal(
    out,
    '# Order\nid: 42\n\n## address\ncity: Berlin\nzip: "10115"'
  )
})

test('serializes arrays of objects with indented continuation', () => {
  const out = serialize(
    { items: [{ sku: 'A1', qty: 2 }, { sku: 'B3', qty: 1 }] },
    'Order'
  )
  assert.equal(
    out,
    '# Order\n\n## items[]\n- sku: A1\n  qty: 2\n- sku: B3\n  qty: 1'
  )
})

test('serializes multiline strings as blockquotes', () => {
  const out = serialize({ body: 'Line 1\nLine 2\n\nLine 4' }, 'Doc')
  assert.equal(out, '# Doc\nbody:\n> Line 1\n> Line 2\n>\n> Line 4')
})

test('serializes frontmatter above the root heading', () => {
  const out = serialize(
    { status: 'active' },
    'Orders',
    { page: 1, 'page-size': 50 }
  )
  assert.equal(
    out,
    'page: 1\npage-size: 50\n\n# Orders\nstatus: active'
  )
})

// --- Round trips ---------------------------------------------------------

test('round-trips a complex document', () => {
  const original = {
    id: 42,
    status: 'pending',
    paid: false,
    notes: null,
    address: {
      street: 'Hauptstraße 1',
      city: 'Berlin',
      geo: { lat: 52.52, lng: 13.40 }
    },
    tags: ['express', 'fragile'],
    items: [
      { sku: 'A1', qty: 2, price: 29.99 },
      { sku: 'B3', qty: 1, price: 24.99 }
    ]
  }
  const text = serialize(original, 'Order')
  const { value } = parse(text)
  assert.deepEqual(value, original)
})
