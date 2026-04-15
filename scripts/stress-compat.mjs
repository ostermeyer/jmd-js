// Cross-implementation stress test.
//
// Generates a batch of pseudo-random JSON documents, feeds each through
// the Python reference serializer and the JS serializer, and reports any
// divergence. Exit non-zero on any mismatch. Seeded so runs are
// reproducible.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { serialize, parse } from '../src/index.js'

const PY_IMPL = path.resolve(import.meta.dirname, '../..', 'jmd-impl')
const SEED = Number(process.env.STRESS_SEED ?? 1)
const COUNT = Number(process.env.STRESS_COUNT ?? 200)

// Deterministic PRNG (mulberry32).
function prng(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = prng(SEED)
const pick = arr => arr[Math.floor(rand() * arr.length)]

const KEYS = ['id', 'name', 'status', 'title', 'address', 'city', 'qty',
  'price', 'tags', 'items', 'meta', 'notes', 'code', 'kind', 'value',
  'count', 'page', 'total']

const SCALAR_STRINGS = ['hello', 'hello world', 'Berlin', 'Hauptstraße 1',
  'A1', 'B3', 'pending', 'active', 'complete', 'Line 1\nLine 2',
  'tab\there', 'quoted "word"', 'back\\slash', 'mixed ünïcødé']

function genScalar(depth) {
  switch (Math.floor(rand() * 7)) {
    case 0: return null
    case 1: return rand() < 0.5
    case 2: return Math.floor(rand() * 1000) - 500
    case 3: return Math.round(rand() * 10000) / 100
    case 4: return ''
    case 5: return pick(SCALAR_STRINGS)
    case 6: return String(Math.floor(rand() * 100))  // numeric-looking
  }
}

function genValue(depth = 0, maxDepth = 4) {
  if (depth >= maxDepth || rand() < 0.35) return genScalar(depth)
  const isArray = rand() < 0.4
  if (isArray) {
    const n = Math.floor(rand() * 4) + 1
    const items = []
    // Pick a uniform item-kind so we mostly produce homogeneous arrays
    // (the well-defined canonical case).
    const kind = pick(['scalar', 'object', 'sub-array'])
    for (let i = 0; i < n; i++) {
      if (kind === 'scalar') items.push(genScalar(depth))
      else if (kind === 'object') items.push(genObject(depth + 1, maxDepth))
      else items.push([genScalar(depth), genScalar(depth)])
    }
    return items
  }
  return genObject(depth, maxDepth)
}

function genObject(depth, maxDepth) {
  const keys = new Set()
  const n = Math.floor(rand() * 4) + 1
  while (keys.size < n) keys.add(pick(KEYS))
  const obj = {}
  for (const k of keys) obj[k] = genValue(depth + 1, maxDepth)
  return obj
}

const labels = ['Order', 'Document', 'Product', 'Report', 'Data']

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-stress-'))
try {
  const cases = []
  for (let i = 0; i < COUNT; i++) {
    const value = rand() < 0.15
      ? Array.from({ length: Math.floor(rand() * 4) + 1 },
          () => genObject(1, 4))
      : genObject(0, 4)
    cases.push({ value, label: pick(labels) })
  }

  // Ask Python once, in bulk, to serialize the whole batch — one process
  // startup instead of one per case.
  const inputPath = path.join(tmpDir, 'cases.json')
  fs.writeFileSync(inputPath, JSON.stringify(cases))
  const script = `
import json, sys
import jmd
cases = json.load(open(${JSON.stringify(inputPath)}))
out = [jmd.serialize(c['value'], label=c['label']) for c in cases]
sys.stdout.write(json.dumps(out))
`
  const pyOut = execFileSync('uv', ['run', '--quiet', 'python', '-c', script],
    { cwd: PY_IMPL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const pyResults = JSON.parse(pyOut)

  let diverged = 0
  let rtBroken = 0
  for (let i = 0; i < cases.length; i++) {
    const js = serialize(cases[i].value, cases[i].label)
    if (js !== pyResults[i]) {
      diverged++
      if (diverged <= 3) {
        console.log('--- byte divergence #' + i + ' label=' + JSON.stringify(cases[i].label))
        console.log('value:', JSON.stringify(cases[i].value))
        console.log('PY:', JSON.stringify(pyResults[i]))
        console.log('JS:', JSON.stringify(js))
      }
    }
    try {
      const parsed = parse(js)
      if (!deepEqual(parsed.value, cases[i].value)) {
        rtBroken++
        if (rtBroken <= 3) {
          console.log('--- round-trip #' + i + ' value diverges')
          console.log('orig:', JSON.stringify(cases[i].value))
          console.log('back:', JSON.stringify(parsed.value))
          console.log('text:', JSON.stringify(js))
        }
      }
    } catch (e) {
      rtBroken++
      if (rtBroken <= 3) {
        console.log('--- round-trip #' + i + ' threw:', e.message)
        console.log('text:', JSON.stringify(js))
      }
    }
  }

  console.log('\nSummary: bytes ' + (COUNT - diverged) + '/' + COUNT
    + ', round-trip ' + (COUNT - rtBroken) + '/' + COUNT)
  if (diverged > 0 || rtBroken > 0) process.exitCode = 1
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false
  return true
}
