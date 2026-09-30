# ADR-0006: The `.ppad` script format

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

A script needs metadata next to its code: language, execution mode, the connection it targets
(Phase 4), packages (Phase 7) and implicit imports. Scripts live in a folder the user owns, are
committed to git and edited by other tools, so the file must stay readable, diff well and never
be damaged by a round trip through PolyPad. The spec asks for a JSON header, a separator and the
code, with version migrations, and forbids copying LINQPad's format.

## Decision

A `.ppad` file is a JSON object (the header), a line containing exactly `---`, then the code
verbatim to the end of the file:

```text
{
  "ppad": 1,
  "language": "csharp",
  "mode": "statements",
  "connection": null,
  "packages": [],
  "imports": []
}
---
Console.WriteLine("Hello");
```

- **Parsing** reads exactly one JSON value with `serde_json`'s streaming deserializer and only
  then requires the separator, so nothing inside the header can end it early. Everything after
  the separator line is code, byte for byte.
- **`ppad` is both magic value and format version.** Older versions are migrated in memory
  through a chain of steps and rewritten only when the user saves. A newer version is refused:
  PolyPad never overwrites data it does not understand.
- **Round trips are byte-exact** for files PolyPad writes: known keys in a fixed order, unknown
  keys preserved and written after them (sorted), two-space indentation, UTF-8 without BOM (a BOM
  is accepted when reading), and the header's line ending (LF or CRLF) reused.
- **Validation:** `language` and `mode` must be known ids; a known mode the language does not
  offer falls back to the language's default and marks the document as changed. Files above
  16 MiB are refused.
- **Ids** (`csharp`, `typescript`, `statements`…) are defined once in Rust (`Language`,
  `ExecutionMode`) and exported to the UI, because they are part of the file format.
- **Over IPC**, unknown fields travel as JSON text, not as objects: the UI never interprets them,
  and JavaScript numbers would round integers above 2^53, changing the file on the next save.

## Alternatives

- **A comment block at the top of the code** (as some notebooks do): needs a comment syntax per
  language and breaks for SQL dialects and for code that must start with a directive.
- **A sidecar metadata file:** doubles every rename, move and delete, and gets lost when a
  script is copied alone.
- **YAML front matter:** friendlier to edit by hand, but a second parser, implicit typing
  surprises (`no` as a boolean) and no advantage for machine-written metadata.

## Consequences

- The parser and serializer are covered by unit tests for every error and by property tests
  (arbitrary headers and code, code containing `---` lines, mixed line endings, arbitrary input
  never panics).
- Each future format version adds one migration step with a fixture test of the older layout.
- Hand-edited headers that break the rules produce precise errors (line and column) instead of
  being "repaired" silently.
