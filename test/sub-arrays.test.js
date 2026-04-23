// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, serialize } from '../src/index.js'

test('parses a matrix of scalars', () => {
  const text = [
    '# Data',
    '## matrix[]',
    '### []',
    '- 1',
    '- 2',
    '### []',
    '- 3',
    '- 4'
  ].join('\n')
  const { value } = parse(text)
  assert.deepEqual(value, { matrix: [[1, 2], [3, 4]] })
})

test('serializes a matrix of scalars', () => {
  const out = serialize({ matrix: [[1, 2], [3, 4]] }, 'Data')
  assert.equal(
    out,
    '# Data\n\n## matrix[]\n### []\n- 1\n- 2\n### []\n- 3\n- 4'
  )
})

test('round-trips a matrix of scalars', () => {
  const original = { matrix: [[1, 2], [3, 4], [5, 6]] }
  const { value } = parse(serialize(original, 'Data'))
  assert.deepEqual(value, original)
})

test('parses a matrix of objects', () => {
  const text = [
    '# Schedule',
    '## grid[]',
    '### []',
    '- day: Mon',
    '  time: "09:00"',
    '- day: Tue',
    '  time: "10:00"',
    '### []',
    '- day: Wed',
    '  time: "14:00"'
  ].join('\n')
  const { value } = parse(text)
  assert.deepEqual(value, {
    grid: [
      [{ day: 'Mon', time: '09:00' }, { day: 'Tue', time: '10:00' }],
      [{ day: 'Wed', time: '14:00' }]
    ]
  })
})

test('round-trips a matrix of objects', () => {
  const original = {
    grid: [
      [{ day: 'Mon', time: '09:00' }, { day: 'Tue', time: '10:00' }],
      [{ day: 'Wed', time: '14:00' }]
    ]
  }
  const text = serialize(original, 'Schedule')
  const { value } = parse(text)
  assert.deepEqual(value, original)
})

test('parses a root-level array of arrays', () => {
  const text = '# []\n## []\n- 1\n- 2\n## []\n- 3\n- 4\n'
  const { value } = parse(text)
  assert.deepEqual(value, [[1, 2], [3, 4]])
})

test('serializes a root-level array of arrays', () => {
  const out = serialize([[1, 2], [3, 4]], '[]')
  assert.equal(out, '# []\n## []\n- 1\n- 2\n## []\n- 3\n- 4')
})

test('round-trips a root-level array of arrays', () => {
  const original = [[1, 2, 3], [4, 5], [6]]
  const { value } = parse(serialize(original, '[]'))
  assert.deepEqual(value, original)
})
