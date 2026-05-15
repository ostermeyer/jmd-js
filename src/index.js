// SPDX-License-Identifier: Apache-2.0
// jmd-format — JavaScript reference implementation.
//
// Public surface: minimal on purpose. Batch API for the common case,
// streaming API for large or incremental workloads.

export { parse, createParser, toLines, JMDParseError } from './parser.js'
export { serialize, serializeLines, validateLabel } from './serializer.js'
