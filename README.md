# jmd-format

**JMD (JSON Markdown) — JavaScript reference implementation.**

JMD is a structured data format for LLM-driven infrastructure, designed to
work *with* the natural generation behavior of large language models rather
than against it. See the [JMD specification](https://github.com/ostermeyer/jmd-spec)
for the format itself.

This package is the JavaScript reference implementation. A Python reference
implementation exists as the `jmd-format` package on PyPI.

## Status

**Early development.** The API shape is settled; feature coverage is
partial and advances toward full specification conformance.

## Install

```
npm install jmd-format
```

Node 20+ required. Pure ESM, no transpilation, no dependencies.

## Usage

```js
import { parse, serialize } from 'jmd-format'

const text = `# Order
id: 42
status: pending
## address
city: Berlin
`

const { mode, label, frontmatter, value } = parse(text)
// mode:        'data'
// label:       'Order'
// frontmatter: {}
// value:       { id: 42, status: 'pending', address: { city: 'Berlin' } }

const out = serialize({ id: 42, status: 'pending' }, 'Order')
// "# Order\nid: 42\nstatus: pending\n"
```

Frontmatter and alternate root modes are expressed at the call site:

```js
serialize(value, '? Order', { page: 1, 'page-size': 50 })  // query mode
serialize(value, '! Order')                                 // schema mode
serialize(value, '- Order')                                 // delete mode
```

## Currently supported

- All four document modes (`#`, `#!`, `#?`, `#-`): parsing recognizes the
  mode and extracts the label; the body parses as standard JMD.
- Scalars: `null`, `true`, `false`, numbers, bare and quoted strings.
- Nested objects via heading depth.
- Arrays of scalars and of objects (with indented continuation fields).
- Blockquote multiline strings (§9.1).
- Frontmatter (§3.5): both `key: value` and bare-key forms.
- Blank-line scope reset (§7.2a).
- Scalar headings for scope return (`## total: 84.99`, §7.2).
- Anonymous headings (§3.2a).

## Not yet supported

Planned for subsequent releases; parser throws a clear error if encountered.

- Streaming API (async generator) — the line-oriented core is ready,
  the public streaming surface will land in 0.2.
- Sub-arrays (`### []`).
- Thematic breaks (`---`) as array-item separators.
- Depth-qualified items (`## -`, `### -`).
- Depth+1 items (items one heading level deeper than the array heading).
- Schema-specific type expressions, QBE filter conditions — parsed as raw
  strings today; structured interpretation will follow.

## Design

JavaScript-native throughout:

- Functions and closures, not classes. No `new`, no `this`.
- Plain objects as data carriers.
- ESM only; no build step.
- No external dependencies.
- Zero Node-specific APIs in the core — runs in the browser unchanged.

The implementation is strict on the generator side and tolerant on the
parser side, following §22.1 of the specification.

## License

MIT — see [LICENSE](./LICENSE).
