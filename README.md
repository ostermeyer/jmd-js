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

### Batch

```js
import { parse, serialize } from 'jmd-format'

const { mode, label, frontmatter, value } = parse(text)
const out = serialize({ id: 42, status: 'pending' }, 'Order')
```

Frontmatter and alternate root modes are expressed at the call site:

```js
serialize(value, '? Order', { page: 1, 'page-size': 50 })  // query mode
serialize(value, '! Order')                                 // schema mode
serialize(value, '- Order')                                 // delete mode
```

### Streaming

The parser and serializer both have streaming surfaces — async generator
for input, sync generator for output. Events follow the sequence from
spec §18.2.

```js
import { createParser, toLines, serializeLines } from 'jmd-format'

// Parse a stream of arbitrary text chunks (e.g. an HTTP response body).
const parser = createParser()
for await (const event of parser.events(toLines(response.body))) {
  // event: { type: 'field', key: 'id', value: 42 }
  // event: { type: 'object_start', key: 'address' }
  // event: { type: 'document_end' }
}

// Serialize line by line.
for (const line of serializeLines(value, 'Orders')) {
  res.write(line)  // each line includes its trailing newline
}
```

`toLines(source)` is the adapter that turns an async iterable of arbitrary
string chunks into an async iterable of complete lines.

## Currently supported

- All four document modes (`#`, `#!`, `#?`, `#-`): parsing recognizes the
  mode and extracts the label; the body parses as standard JMD.
- Scalars: `null`, `true`, `false`, numbers, bare and quoted strings.
- Nested objects via heading depth.
- Arrays of scalars and of objects (with indented continuation fields).
- Sub-arrays and arrays of arrays (`### []`, §8.4).
- Blockquote multiline strings (§9.1).
- Frontmatter (§3.5): both `key: value` and bare-key forms.
- Blank-line scope reset (§7.2a).
- Scalar headings for scope return (`## total: 84.99`, §7.2).
- Anonymous headings (§3.2a).
- **Streaming parser** via async generator: events match the sequence
  defined in §18.2 (document_start, field, field_start, field_content,
  object_start/end, array_start/end, item_start/value/end, scope_reset,
  document_end, frontmatter).
- **Streaming serializer** via sync generator (`serializeLines`).
- Line adapter (`toLines`) to convert chunked input to lines.

## Not yet supported

Planned for subsequent releases; parser throws a clear error if encountered.

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
