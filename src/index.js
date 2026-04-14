// jmd-format — JavaScript reference implementation.
//
// Public surface. Minimal on purpose: the shape of the API is the
// message. Everything deeper is available through createParser.

export { parse, createParser } from './parser.js'
export { serialize } from './serializer.js'
