// Conformance against the canonical JMD test suite.
//
// Fixtures live in the sibling jmd-spec repository at conformance/.
// Override the search path with the JMD_FIXTURES environment variable
// if jmd-spec is checked out elsewhere.
//
// Each fixture is a pair <name>.jmd + <name>.json. For every pair we
// run three tests:
//
//   1. Parse     — parse(.jmd).value deep-equals .json
//   2. Serialize — serialize(.json, label, frontmatter) equals .jmd
//                  byte-for-byte (label and frontmatter are reconstructed
//                  from the parsed .jmd)
//   3. Round-trip — parse(serialize(parse(.jmd).value, ...)) yields the
//                   same value. Follows from 1 and 2 but validates the
//                   cycle end-to-end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { parse, serialize } from '../src/index.js'

const MODE_PREFIX = { data: '', schema: '! ', query: '? ', delete: '- ' }

function findFixturesDir() {
  if (process.env.JMD_FIXTURES) return process.env.JMD_FIXTURES
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidate = path.resolve(here, '..', '..', 'jmd-spec', 'conformance')
  return existsSync(candidate) ? candidate : null
}

function listModes(root) {
  return readdirSync(root)
    .filter(name => statSync(path.join(root, name)).isDirectory())
    .sort()
}

function listPairs(modeDir) {
  const files = readdirSync(modeDir)
  const bases = new Set()
  for (const f of files) {
    if (f.endsWith('.jmd')) bases.add(f.slice(0, -4))
  }
  return [...bases].sort().filter(b => files.includes(b + '.json'))
}

function labelArg(mode, label) {
  return (MODE_PREFIX[mode] ?? '') + label
}

const root = findFixturesDir()

if (!root) {
  test('conformance suite', { skip: 'jmd-spec fixtures not found — clone ostermeyer/jmd-spec as a sibling or set JMD_FIXTURES' }, () => {})
} else {
  for (const mode of listModes(root)) {
    const modeDir = path.join(root, mode)
    for (const name of listPairs(modeDir)) {
      const jmdText = readFileSync(path.join(modeDir, name + '.jmd'), 'utf8')
      const jsonText = readFileSync(path.join(modeDir, name + '.json'), 'utf8')
      const expected = JSON.parse(jsonText)

      test(`${mode}/${name} — parse`, () => {
        const { value } = parse(jmdText)
        assert.deepEqual(value, expected)
      })

      test(`${mode}/${name} — serialize`, () => {
        const parsed = parse(jmdText)
        const out = serialize(
          expected,
          labelArg(parsed.mode, parsed.label),
          Object.keys(parsed.frontmatter).length ? parsed.frontmatter : null
        )
        // Fixture files end with a single trailing newline; the serializer
        // mirrors the byte form emitted by the Python reference (no
        // trailing newline — callers add it when writing a file).
        assert.equal(out + '\n', jmdText)
      })

      test(`${mode}/${name} — round-trip`, () => {
        const parsed = parse(jmdText)
        const out = serialize(
          parsed.value,
          labelArg(parsed.mode, parsed.label),
          Object.keys(parsed.frontmatter).length ? parsed.frontmatter : null
        )
        const { value } = parse(out)
        assert.deepEqual(value, expected)
      })
    }
  }
}
