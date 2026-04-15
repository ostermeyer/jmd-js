// jmd-format — JavaScript reference implementation.
//
// Public surface: minimal on purpose. Batch API for the common case,
// streaming API for large or incremental workloads.

export { parse, createParser, toLines } from './parser.js'
export { serialize, serializeLines } from './serializer.js'
