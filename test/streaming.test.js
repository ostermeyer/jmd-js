import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createParser, toLines, serializeLines, serialize } from '../src/index.js'

// Helper: turn a plain text document into an async iterable of lines.
// A trailing newline is a terminator, not a blank line.
async function* linesOf(text) {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) yield line
}

// Helper: collect events from the async generator.
async function collect(asyncIter) {
  const out = []
  for await (const ev of asyncIter) out.push(ev)
  return out
}

// --- Events from parser --------------------------------------------------

test('streaming parser emits document_start, field, document_end', async () => {
  const events = await collect(
    createParser().events(linesOf('# Order\nid: 42\n'))
  )
  assert.deepEqual(events, [
    { type: 'document_start', mode: 'data', label: 'Order' },
    { type: 'field', key: 'id', value: 42 },
    { type: 'object_end', key: undefined },
    { type: 'document_end' }
  ])
})

test('streaming parser emits object_start and object_end for nested objects', async () => {
  const text = '# Order\nid: 42\n## address\ncity: Berlin\n'
  const events = await collect(createParser().events(linesOf(text)))
  const types = events.map(e => e.type)
  assert.deepEqual(types, [
    'document_start',
    'field',            // id
    'object_start',     // address
    'field',            // city
    'object_end',       // address
    'object_end',       // root
    'document_end'
  ])
})

test('streaming parser emits array events and item lifecycle', async () => {
  const text = '# Order\n## items[]\n- sku: A1\n  qty: 2\n- sku: B3\n'
  const events = await collect(createParser().events(linesOf(text)))
  const types = events.map(e => e.type)
  assert.deepEqual(types, [
    'document_start',
    'array_start',
    'item_start',
    'field',            // sku: A1
    'field',            // qty: 2
    'item_end',
    'item_start',
    'field',            // sku: B3
    'item_end',
    'array_end',
    'object_end',       // root
    'document_end'
  ])
})

test('streaming parser emits scalar array items as item_value', async () => {
  const text = '# Tags\n## list[]\n- a\n- b\n- c\n'
  const events = await collect(createParser().events(linesOf(text)))
  const scalarItems = events.filter(e => e.type === 'item_value').map(e => e.value)
  assert.deepEqual(scalarItems, ['a', 'b', 'c'])
})

test('streaming parser emits field_start and field_content for blockquotes', async () => {
  const text = '# Article\nbody:\n> First line\n> Second line\n'
  const events = await collect(createParser().events(linesOf(text)))
  assert.deepEqual(
    events.filter(e => e.type === 'field_start' || e.type === 'field_content'),
    [
      { type: 'field_start', key: 'body' },
      { type: 'field_content', text: 'First line' },
      { type: 'field_content', text: 'Second line' }
    ]
  )
})

test('streaming parser emits frontmatter before document_start', async () => {
  const text = 'page: 1\npage-size: 50\n\n# Orders\nstatus: active\n'
  const events = await collect(createParser().events(linesOf(text)))
  assert.deepEqual(events[0], { type: 'frontmatter', key: 'page', value: 1 })
  assert.deepEqual(events[1], { type: 'frontmatter', key: 'page-size', value: 50 })
  assert.equal(events[2].type, 'document_start')
})

test('streaming parser emits scope_reset on blank line', async () => {
  const text = '# Order\n## address\ncity: Berlin\n\ntotal: 84.99\n'
  const events = await collect(createParser().events(linesOf(text)))
  const resetIdx = events.findIndex(e => e.type === 'scope_reset')
  assert.ok(resetIdx > 0, 'scope_reset should be emitted')
  // After scope_reset, the object_end for address follows, then field total.
  assert.equal(events[resetIdx + 1].type, 'object_end')
})

// --- toLines adapter -----------------------------------------------------

test('toLines splits chunks on newlines', async () => {
  async function* chunks() {
    yield '# Ord'
    yield 'er\nid: '
    yield '42\n'
  }
  const lines = []
  for await (const line of toLines(chunks())) lines.push(line)
  assert.deepEqual(lines, ['# Order', 'id: 42'])
})

test('toLines strips CR before LF', async () => {
  async function* chunks() {
    yield 'a\r\nb\r\nc'
  }
  const lines = []
  for await (const line of toLines(chunks())) lines.push(line)
  assert.deepEqual(lines, ['a', 'b', 'c'])
})

test('toLines emits final unterminated line', async () => {
  async function* chunks() {
    yield 'hello'
  }
  const lines = []
  for await (const line of toLines(chunks())) lines.push(line)
  assert.deepEqual(lines, ['hello'])
})

test('events() composes with toLines() for chunked input', async () => {
  async function* chunks() {
    yield '# Ord'
    yield 'er\nid: 42\nstatus: pen'
    yield 'ding\n'
  }
  const events = await collect(createParser().events(toLines(chunks())))
  const fields = events.filter(e => e.type === 'field')
  assert.deepEqual(fields, [
    { type: 'field', key: 'id', value: 42 },
    { type: 'field', key: 'status', value: 'pending' }
  ])
})

// --- serializeLines generator --------------------------------------------

test('serializeLines yields lines with trailing newlines', () => {
  const lines = [...serializeLines({ id: 42, status: 'pending' }, 'Order')]
  assert.deepEqual(lines, ['# Order\n', 'id: 42\n', 'status: pending\n'])
})

test('serializeLines and serialize produce the same output', () => {
  const value = {
    id: 42,
    address: { city: 'Berlin' },
    tags: ['a', 'b']
  }
  const streamed = [...serializeLines(value, 'Order')].join('')
  const batch = serialize(value, 'Order')
  assert.equal(streamed, batch)
})
