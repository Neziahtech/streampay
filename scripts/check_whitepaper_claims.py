#!/usr/bin/env python3
"""Audit docs/WHITEPAPER.md's claim-to-code traceability table.

For every row between <!-- claims:begin --> and <!-- claims:end -->:
  - the cited file exists,
  - the cited line or range lies inside the file,
  - the anchor snippet appears within the cited lines (whitespace-insensitive).
And across the document:
  - every [Cn] cited in the text has a row,
  - every row is cited at least once in the text,
  - ids are unique.

A failing row means the code moved under the paper: fix the location, and
re-read the claim while you are there — a moved line is how a claim goes stale.

  python3 scripts/check_whitepaper_claims.py [path/to/WHITEPAPER.md]
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "WHITEPAPER.md")

ROW = re.compile(r"^\|\s*(C\d+)\s*\|(.+?)\|\s*`([^`:]+):(\d+)(?:-(\d+))?`\s*\|\s*`(.+)`\s*\|\s*$")
CITE = re.compile(r"\[(C\d+)\]")


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def main() -> int:
    with open(DOC, encoding="utf-8") as f:
        doc = f.read()
    try:
        body, rest = doc.split("<!-- claims:begin -->", 1)
        table, _ = rest.split("<!-- claims:end -->", 1)
    except ValueError:
        print(f"{DOC}: claims markers not found", file=sys.stderr)
        return 1

    errors, rows = [], {}
    for n, line in enumerate(table.splitlines(), 1):
        if not line.startswith("| C"):
            continue
        m = ROW.match(line)
        if not m:
            errors.append(f"table line {n}: not a well-formed claim row: {line[:80]}")
            continue
        cid, _claim, path, start, end, anchor = m.groups()
        start, end = int(start), int(end or start)
        if cid in rows:
            errors.append(f"{cid}: duplicate id")
        rows[cid] = (path, start, end)

        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            errors.append(f"{cid}: {path} does not exist")
            continue
        with open(full, encoding="utf-8") as src:
            lines = src.read().splitlines()
        if not (1 <= start <= end <= len(lines)):
            errors.append(f"{cid}: {path}:{start}-{end} is outside the file ({len(lines)} lines)")
            continue
        if squash(anchor) not in squash("\n".join(lines[start - 1 : end])):
            errors.append(f"{cid}: anchor `{anchor}` not found in {path}:{start}-{end}")

    cited = set(CITE.findall(body))
    for cid in sorted(cited - rows.keys(), key=lambda c: int(c[1:])):
        errors.append(f"{cid}: cited in the text but has no row")
    for cid in sorted(rows.keys() - cited, key=lambda c: int(c[1:])):
        errors.append(f"{cid}: has a row but is never cited in the text")

    if errors:
        print(f"{len(errors)} traceability error(s) in {os.path.relpath(DOC, ROOT)}:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"OK: {len(rows)} claims verified against the code; all cited, all present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
