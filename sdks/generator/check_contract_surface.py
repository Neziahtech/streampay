#!/usr/bin/env python3
"""Schema guard: the checked-in spec must match the Rust contract surface.

The spec IR in ``sdks/spec/streampay.spec.json`` is the single source of truth
for every generated SDK. This guard parses the contract sources and fails when
the two drift, so a contract change cannot silently ship stale clients.

Checks
  * function names, argument names/types, and return types from the
    ``#[contractimpl]`` block in ``lib.rs``
  * ``Stream`` fields and ``StreamStatus`` cases from ``stream.rs``
  * numeric constants exposed in the IR
  * ``StreamError`` variant names and codes from ``errors.rs``
  * event names, topic symbols, topic fields, and data fields from
    ``events.rs``
  * the spec fingerprint (``FINGERPRINT`` file) against the canonical JSON

Usage
  python3 sdks/generator/check_contract_surface.py [--update-fingerprint]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "contracts" / "streaming-payments" / "src"
SPEC_PATH = ROOT / "sdks" / "spec" / "streampay.spec.json"
FINGERPRINT_PATH = ROOT / "sdks" / "spec" / "FINGERPRINT"


def canonical_bytes(spec: dict) -> bytes:
    return json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def fingerprint(spec: dict) -> str:
    return hashlib.sha256(canonical_bytes(spec)).hexdigest()


def camel_to_snake(name: str) -> str:
    s = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


def rust_type_to_ir(rust: str) -> object:
    rust = rust.strip()
    match = re.fullmatch(r"Vec<(\w+)>", rust)
    if match:
        return {"vec": rust_type_to_ir(match.group(1))}
    table = {
        "Address": "address",
        "i128": "i128",
        "u128": "u128",
        "u64": "u64",
        "u32": "u32",
        "i32": "i32",
        "bool": "bool",
        "String": "string",
    }
    if rust in table:
        return table[rust]
    # A named contract type (struct or enum).
    if re.fullmatch(r"[A-Z]\w*", rust):
        return rust
    raise ValueError(f"cannot map Rust type {rust!r} to the spec IR")


def split_top_level(text: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current = ""
    for char in text:
        if char == "<":
            depth += 1
        elif char == ">":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current)
    return [part.strip() for part in parts if part.strip()]


def parse_impl_functions(source: str) -> list[dict]:
    start = source.index("impl StreamingPayments {")
    # Take the whole impl block; the contract has no nested braces at depth 0
    # other than the impl body itself.
    body = source[start:]
    functions = []
    for match in re.finditer(
        r"pub fn (\w+)\(\s*env: Env,\s*(.*?)\)\s*->\s*([^{]+?)\s*\{",
        body,
        re.DOTALL,
    ):
        name, params, ret = match.groups()
        args = []
        for param in split_top_level(params):
            arg_name, _, arg_type = param.partition(":")
            args.append({"name": arg_name.strip(), "type": rust_type_to_ir(arg_type)})
        ret = ret.strip()
        result = re.fullmatch(r"Result<(.+),\s*StreamError>", ret)
        if result:
            inner = result.group(1).strip()
            returns = "void" if inner == "()" else rust_type_to_ir(inner)
            error = "StreamError"
        else:
            returns = rust_type_to_ir(ret)
            error = None
        functions.append(
            {"name": name, "args": args, "returns": returns, "error": error}
        )
    return functions


def parse_struct_fields(block: str) -> list[dict]:
    fields = []
    for line in block.splitlines():
        match = re.match(r"\s*pub (\w+): ([\w<>]+),", line)
        if match:
            fields.append(
                {"name": match.group(1), "type": rust_type_to_ir(match.group(2))}
            )
    return fields


def block_after(source: str, header: str) -> str:
    start = source.index(header) + len(header)
    depth = 1
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise ValueError(f"unterminated block after {header!r}")


def parse_contract() -> dict:
    lib = (CONTRACT / "lib.rs").read_text()
    stream = (CONTRACT / "stream.rs").read_text()
    errors = (CONTRACT / "errors.rs").read_text()
    events = (CONTRACT / "events.rs").read_text()

    functions = parse_impl_functions(lib)

    stream_block = block_after(stream, "pub struct Stream {")
    structs = [{"name": "Stream", "fields": parse_struct_fields(stream_block)}]

    enum_block = block_after(stream, "pub enum StreamStatus {")
    cases = []
    value = 0
    for line in enum_block.splitlines():
        match = re.match(r"\s{4}([A-Z]\w*),", line)
        if match:
            cases.append({"name": match.group(1), "value": value})
            value += 1
    enums = [{"name": "StreamStatus", "cases": cases}]

    constants = {}
    for match in re.finditer(r"pub const (\w+): u64 = ([0-9_]+);", stream):
        constants[match.group(1)] = int(match.group(2).replace("_", ""))

    error_variants = [
        {"name": name, "code": int(code)}
        for name, code in re.findall(r"(\w+) = (\d+),", errors)
    ]

    event_list = []
    for match in re.finditer(r"pub struct (\w+) \{", events):
        name = match.group(1)
        body = block_after(events[match.end() - 1 :], "{")
        topics, data = [], []
        lines = body.splitlines()
        for index, line in enumerate(lines):
            field = re.match(r"\s*pub (\w+): ([\w<>]+),", line)
            if not field:
                continue
            is_topic = index > 0 and "#[topic]" in lines[index - 1]
            entry = {"name": field.group(1), "type": rust_type_to_ir(field.group(2))}
            (topics if is_topic else data).append(entry)
        event_list.append(
            {
                "name": name,
                "topic": camel_to_snake(name),
                "topicFields": topics,
                "dataFields": data,
            }
        )

    return {
        "functions": functions,
        "structs": structs,
        "enums": enums,
        "constants": constants,
        "errors": error_variants,
        "events": event_list,
    }


def compare(spec: dict, contract: dict) -> list[str]:
    problems: list[str] = []

    spec_functions = {f["name"]: f for f in spec["functions"]}
    contract_functions = {f["name"]: f for f in contract["functions"]}
    for name in sorted(contract_functions.keys() - spec_functions.keys()):
        problems.append(f"function `{name}` exists in the contract but not in the spec")
    for name in sorted(spec_functions.keys() - contract_functions.keys()):
        problems.append(f"function `{name}` exists in the spec but not in the contract")
    for name in sorted(spec_functions.keys() & contract_functions.keys()):
        expected, actual = spec_functions[name], contract_functions[name]
        if expected["args"] != actual["args"]:
            problems.append(
                f"function `{name}` args drifted: spec={expected['args']} contract={actual['args']}"
            )
        if expected["returns"] != actual["returns"]:
            problems.append(
                f"function `{name}` returns drifted: spec={expected['returns']} contract={actual['returns']}"
            )
        if expected["error"] != actual["error"]:
            problems.append(
                f"function `{name}` fallibility drifted: spec={expected['error']} contract={actual['error']}"
            )

    spec_structs = {s["name"]: s["fields"] for s in spec["structs"]}
    for struct in contract["structs"]:
        if struct["name"] not in spec_structs:
            problems.append(f"struct `{struct['name']}` missing from the spec")
        elif spec_structs[struct["name"]] != struct["fields"]:
            problems.append(
                f"struct `{struct['name']}` fields drifted: "
                f"spec={spec_structs[struct['name']]} contract={struct['fields']}"
            )

    spec_enums = {
        e["name"]: [{"name": c["name"], "value": c["value"]} for c in e["cases"]]
        for e in spec["enums"]
    }
    for enum in contract["enums"]:
        if enum["name"] not in spec_enums:
            problems.append(f"enum `{enum['name']}` missing from the spec")
        elif spec_enums[enum["name"]] != enum["cases"]:
            problems.append(
                f"enum `{enum['name']}` cases drifted: "
                f"spec={spec_enums[enum['name']]} contract={enum['cases']}"
            )

    for name, value in contract["constants"].items():
        if name in spec["constants"]:
            expected = spec["constants"][name]
            expected_value = expected["value"] if isinstance(expected, dict) else expected
            if expected_value != value:
                problems.append(
                    f"constant `{name}` drifted: spec={expected_value} contract={value}"
                )

    spec_errors = {e["name"]: e["code"] for e in spec["errors"]}
    contract_errors = {e["name"]: e["code"] for e in contract["errors"]}
    if spec_errors != contract_errors:
        problems.append(
            f"error codes drifted: spec={spec_errors} contract={contract_errors}"
        )

    spec_events = {e["name"]: e for e in spec["events"]}
    for event in contract["events"]:
        if event["name"] not in spec_events:
            problems.append(f"event `{event['name']}` missing from the spec")
            continue
        expected = spec_events[event["name"]]
        for key in ("topic", "topicFields", "dataFields"):
            if expected[key] != event[key]:
                problems.append(
                    f"event `{event['name']}` {key} drifted: "
                    f"spec={expected[key]} contract={event[key]}"
                )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-fingerprint",
        action="store_true",
        help="rewrite sdks/spec/FINGERPRINT from the current spec",
    )
    args = parser.parse_args()

    spec = json.loads(SPEC_PATH.read_text())
    problems = compare(spec, parse_contract())

    digest = fingerprint(spec)
    if args.update_fingerprint:
        FINGERPRINT_PATH.write_text(digest + "\n")
        print(f"fingerprint updated: {digest}")
    else:
        recorded = FINGERPRINT_PATH.read_text().strip() if FINGERPRINT_PATH.exists() else ""
        if recorded != digest:
            problems.append(
                f"spec fingerprint mismatch: recorded={recorded or '<missing>'} "
                f"actual={digest} (run with --update-fingerprint after an intentional change)"
            )

    if problems:
        for problem in problems:
            print(f"spec drift: {problem}", file=sys.stderr)
        return 1
    print(
        f"spec matches the contract surface: {len(spec['functions'])} functions, "
        f"{len(spec['events'])} events, {len(spec['errors'])} errors, sha256 {digest[:12]}…"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
