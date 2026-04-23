# SPDX-License-Identifier: Apache-2.0
"""Regenerate jmd-spec conformance fixtures from Python canonical output.

The .json files remain the authoritative data; we rewrite each .jmd so
its body is byte-for-byte what `jmd.serialize(data, label)` produces,
with any pre-existing frontmatter preserved above the root heading.
"""

from __future__ import annotations

import json
import pathlib

import jmd

SPEC_DATA = pathlib.Path("/Users/andreas/Workspace/jmd-spec/conformance/data")


def extract_label(text: str) -> str:
    """Return the label embedded in the existing .jmd root heading."""
    for raw in text.split("\n"):
        line = raw.rstrip("\r")
        if line.startswith("# "):
            after = line[2:]
            if after == "[]":
                return "[]"
            if after.endswith("[]"):
                return after[:-2]
            return after
    return "Document"


def extract_frontmatter(text: str) -> str:
    """Return the original frontmatter block (may be empty)."""
    lines: list[str] = []
    for raw in text.split("\n"):
        line = raw.rstrip("\r")
        if line.startswith("#"):
            break
        if line == "":
            break
        lines.append(line)
    if not lines:
        return ""
    return "\n".join(lines) + "\n\n"


def regen(base: str) -> None:
    json_path = SPEC_DATA / f"{base}.json"
    jmd_path = SPEC_DATA / f"{base}.jmd"
    data = json.loads(json_path.read_text())
    existing = jmd_path.read_text()
    label = extract_label(existing)
    fm = extract_frontmatter(existing)
    body = jmd.serialize(data, label=label)
    jmd_path.write_text(fm + body + "\n")
    print(f"{base:24} label={label!r:14} {len(body)} bytes")


for path in sorted(SPEC_DATA.glob("*.json")):
    regen(path.stem)
