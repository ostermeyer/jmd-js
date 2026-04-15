"""Generate extra Python-authored byte-compat fixtures.

These cases exercise constructs the hand-authored spec fixtures do not
cover: thematic breaks between array items with nested fields, deeply
nested structures, edge-case scalar values, and mode markers in labels.
"""

from __future__ import annotations

import json
import pathlib

import jmd

OUT = pathlib.Path("/Users/andreas/Workspace/jmd-js/test/fixtures/python")
OUT.mkdir(parents=True, exist_ok=True)


CASES: dict[str, tuple[object, str]] = {
    "thematic-break-items": (
        {
            "rows": [
                {"name": "Alice", "addr": {"city": "Berlin"}},
                {"name": "Bob", "addr": {"city": "Hamburg"}},
            ],
        },
        "People",
    ),
    "empty-array": ({"tags": []}, "Doc"),
    "empty-object": ({"meta": {}}, "Doc"),
    "deep-nesting": (
        {"a": {"b": {"c": {"d": {"e": {"f": 1}}}}}},
        "Deep",
    ),
    "scalars-edgecases": (
        {
            "dash": "-",
            "hash": "# label",
            "dash_prefix": "- item",
            "looks_null": "null",
            "looks_true": "true",
            "looks_num": "3.14",
            "has_newline": "line1\nline2",
            "has_tab": "a\tb",
            "has_quote": 'say "hi"',
            "backslash": "a\\b",
        },
        "Edges",
    ),
    "mixed-heterogeneous-array": (
        {
            "items": [
                1,
                "two",
                {"three": 3},
                [4, 5],
                {"six": {"seven": 7}},
                True,
                None,
            ],
        },
        "Mixed",
    ),
    "label-with-spaces": ({"id": 1}, "Purchase Order"),
    "label-with-quote": ({"id": 1}, "A B"),
    "root-array-scalars": ([1, 2, 3, 4, 5], "[]"),
    "root-array-default-label": ([{"x": 1}, {"x": 2}], "Document"),
}


for name, (data, label) in CASES.items():
    body = jmd.serialize(data, label=label)
    (OUT / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")
    (OUT / f"{name}.jmd").write_text(body)
    (OUT / f"{name}.meta.json").write_text(
        json.dumps({"label": label}, indent=2) + "\n"
    )
    print(f"{name:28} label={label!r:20} {len(body)} bytes")
