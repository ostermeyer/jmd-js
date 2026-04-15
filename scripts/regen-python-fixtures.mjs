// Regenerate Python-authored byte-compat fixtures.
//
// For each .json fixture in jmd-spec/conformance/data/, run the Python
// reference serializer and write the output alongside a minimal meta file
// capturing the label we passed. These frozen artifacts are what the
// byte-compat tests assert against — the Python install is not required
// at test time.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const specDataDir = path.resolve(root, '../jmd-spec/conformance/data')
const outDir = path.resolve(root, 'test/fixtures/python')
const pyImpl = path.resolve(root, '../jmd-impl')

fs.mkdirSync(outDir, { recursive: true })

function labelForFixture(name, data) {
  // Map fixture basenames to the label passed to the Python serializer.
  // Root arrays use '[]'; everything else uses the label found in the
  // hand-authored .jmd file's first line.
  const jmdPath = path.join(specDataDir, name + '.jmd')
  if (!fs.existsSync(jmdPath)) return 'Document'
  const text = fs.readFileSync(jmdPath, 'utf8')

  // Skip frontmatter block: read lines until the first '# …' heading.
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('# ')) {
      const after = line.slice(2)
      if (after === '[]') return '[]'
      if (after.endsWith('[]')) return after.slice(0, -2)
      return after
    }
    if (line.startsWith('#')) return after(line)
  }
  return 'Document'
}

function generate(name) {
  const jsonPath = path.join(specDataDir, name + '.json')
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const label = labelForFixture(name, data)

  const script = `
import json, sys
import jmd
data = json.loads(sys.stdin.read())
sys.stdout.write(jmd.serialize(data, label=${JSON.stringify(label)}))
`
  const out = execFileSync('uv', ['run', '--quiet', 'python', '-c', script], {
    cwd: pyImpl,
    input: JSON.stringify(data),
    encoding: 'utf8'
  })

  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(data, null, 2) + '\n')
  fs.writeFileSync(path.join(outDir, name + '.jmd'), out)
  fs.writeFileSync(
    path.join(outDir, name + '.meta.json'),
    JSON.stringify({ label }, null, 2) + '\n'
  )
  return { name, label, bytes: out.length }
}

const fixtures = fs.readdirSync(specDataDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.slice(0, -5))

for (const name of fixtures) {
  const info = generate(name)
  console.log(`${info.name.padEnd(24)} label=${JSON.stringify(info.label).padEnd(14)} ${info.bytes} bytes`)
}
