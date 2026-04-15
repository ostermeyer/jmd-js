// Byte-compatibility with the jmd-format Python reference implementation.
//
// For every paired fixture in the conformance suite we compare the JS
// serializer's output against the Python serializer's output byte-for-byte.
// Python artifacts are pre-generated into test/fixtures/python/ by
// scripts/regen-python-fixtures.mjs so these tests stay hermetic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { serialize, parse } from '../src/index.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PY_DIR = path.resolve(__dirname, 'fixtures/python')

function listFixtures() {
  if (!fs.existsSync(PY_DIR)) return []
  return fs.readdirSync(PY_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'))
    .map(f => f.slice(0, -5))
}

for (const name of listFixtures()) {
  const jsonPath = path.join(PY_DIR, name + '.json')
  const jmdPath = path.join(PY_DIR, name + '.jmd')
  const metaPath = path.join(PY_DIR, name + '.meta.json')

  test(`byte-compat: ${name}`, () => {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const pythonOut = fs.readFileSync(jmdPath, 'utf8')

    const jsOut = serialize(data, meta.label)
    assert.equal(jsOut, pythonOut, `JS output differs from Python for ${name}`)
  })

  test(`round-trip: ${name}`, {
    // The C-accelerated Python serializer emits ambiguous output for
    // heterogeneous arrays that mix sub-arrays with later dict items —
    // Python's own parser doesn't round-trip it either. Track byte-compat
    // for this case but skip the round-trip assertion.
    skip: name === 'mixed-heterogeneous-array'
      ? 'ambiguous Python serializer output (upstream)'
      : false
  }, () => {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const jsOut = serialize(data, meta.label)
    const parsed = parse(jsOut)
    assert.deepEqual(parsed.value, data)
  })
}
