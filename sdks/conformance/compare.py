#!/usr/bin/env python3
"""Compares the three SDK decoders against each other and the vectors.

Every SDK prints ``{sdk, specFingerprint, vectors: {name: decoded}}``. This
script requires all three payloads to equal the recorded expectation and each
other, so an SDK cannot pass by agreeing with itself.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SDKS = ("rust", "typescript", "python")


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    vectors_dir = Path(argv[0])
    out_dir = Path(argv[1])

    outputs = {sdk: load(out_dir / f"{sdk}.json") for sdk in SDKS}
    problems: list[str] = []

    for sdk, output in outputs.items():
        if output.get("sdk") != sdk:
            problems.append(f"{sdk}.json reports sdk={output.get('sdk')!r}")

    vector_files = sorted(vectors_dir.glob("*.json"))
    if not vector_files:
        print(f"no vectors found in {vectors_dir}", file=sys.stderr)
        return 1

    for path in vector_files:
        before = len(problems)
        vector = load(path)
        name = vector["name"]
        expected = vector["expected"]
        payloads = {}
        for sdk in SDKS:
            output = outputs[sdk]
            if output.get("specFingerprint") != vector["specFingerprint"]:
                problems.append(f"{sdk}: spec fingerprint does not match {path.name}")
            payload = output.get("vectors", {}).get(name)
            if payload is None:
                problems.append(f"{sdk}: missing vector {name}")
                continue
            payloads[sdk] = payload
            if payload != expected:
                problems.append(
                    f"{sdk}: {name} differs from the recorded expectation\n"
                    f"    expected={json.dumps(expected, sort_keys=True)}\n"
                    f"    actual  ={json.dumps(payload, sort_keys=True)}"
                )
        if len(payloads) == len(SDKS):
            reference = payloads["rust"]
            for sdk in SDKS[1:]:
                if payloads[sdk] != reference:
                    problems.append(f"{name}: {sdk} and rust disagree")
        print(f"{name}: " + ("mismatch" if len(problems) > before else "identical"))

    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    print(f"\n{len(vector_files)} vectors decoded identically by {', '.join(SDKS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
