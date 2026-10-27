"""Coverage tests for the schema guard.

The review of the generated-SDK change asked for a test that fails when the
spec's operation set is smaller than the contract's. These tests make that a
property of the repository rather than a one-off manual check:

* every public contract entrypoint must appear in the spec, and
* every entrypoint named by the contract's own ``surface.rs`` branch registry
  must appear as well, so a parser regression cannot quietly shrink the set;
* the parser must see every ``pub fn`` in the ``#[contractimpl]`` block,
  including the deploy-time ``__constructor`` (which has no ``->``);
* events and the contract types they reference must agree with the
  canonical event registry (``schemas/events/registry.json``), which the
  contract's own ``event_registry`` test generates from ``events.rs``.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_contract_surface as guard  # noqa: E402

REGISTRY_PATH = guard.ROOT / "schemas" / "events" / "registry.json"

_RUST = {
    "address": "Address",
    "bool": "bool",
    "i32": "i32",
    "u32": "u32",
    "i128": "i128",
    "u128": "u128",
    "u64": "u64",
    "string": "String",
    "symbol": "Symbol",
    "bytes32": "BytesN<32>",
    "bytes64": "BytesN<64>",
}


def canonical(spec: dict, name: str) -> str:
    """Render a spec type in the event registry's canonical notation."""
    structs = {item["name"]: item for item in spec["structs"]}
    enums = {item["name"]: item for item in spec["enums"]}
    unions = {item["name"]: item for item in spec.get("unions", [])}

    def render(t: object) -> str:
        if isinstance(t, dict):
            if "vec" in t:
                return f"Vec<{render(t['vec'])}>"
            if "option" in t:
                return f"Option<{render(t['option'])}>"
            raise ValueError(t)
        if t in _RUST:
            return _RUST[t]
        return canonical(spec, t)

    if name in structs:
        fields = sorted(structs[name]["fields"], key=lambda f: f["name"])
        return name + "{" + ",".join(f"{f['name']}:{render(f['type'])}" for f in fields) + "}"
    if name in enums:
        return name + "{enum:" + ",".join(sorted(c["name"] for c in enums[name]["cases"])) + "}"
    if name in unions:
        cases = [
            f"{c['name']}(" + "+".join(render(t) for t in c["types"]) + ")"
            for c in unions[name]["cases"]
        ]
        return name + "{payload_enum:" + ",".join(cases) + "}"
    raise KeyError(name)


class SpecCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = guard.parse_contract()
        cls.expected = guard.build_spec(cls.contract)
        cls.spec = json.loads(guard.SPEC_PATH.read_text())
        cls.contract_operations = {
            function["name"]
            for function in cls.contract["functions"]
            if function["name"] not in guard.NON_INVOKABLE
        }
        cls.spec_operations = {function["name"] for function in cls.spec["functions"]}

    def test_spec_covers_every_contract_entrypoint(self) -> None:
        missing = sorted(self.contract_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing contract entrypoints: " + ", ".join(missing),
        )

    def test_spec_has_no_operations_outside_the_contract(self) -> None:
        extra = sorted(self.spec_operations - self.contract_operations)
        self.assertEqual(
            extra,
            [],
            "the spec declares operations the contract does not expose: " + ", ".join(extra),
        )

    def test_spec_covers_the_surface_registry_entrypoints(self) -> None:
        registry_source = (guard.CONTRACT / "surface.rs").read_text()
        start = registry_source.find("pub const fn entrypoints")
        self.assertNotEqual(start, -1, "surface.rs has no entrypoints() registry")
        brace = registry_source.find("{", start)
        end = guard.match_delimiter(registry_source, brace, "{", "}")
        block = registry_source[brace : end + 1]
        named = set(re.findall(r'"(\w+)"', block))
        # The registry also names internal helpers (e.g. `streamed_at`); only
        # real entrypoints are in scope for coverage.
        registry_operations = named & self.contract_operations
        self.assertGreaterEqual(
            len(registry_operations),
            20,
            "the surface registry parse found suspiciously few entrypoints",
        )
        missing = sorted(registry_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing entrypoints named by surface.rs: " + ", ".join(missing),
        )

    def test_parser_sees_every_public_fn_including_the_constructor(self) -> None:
        lib = (guard.CONTRACT / "lib.rs").read_text()
        start = lib.find("impl StreamingPayments {")
        brace = lib.find("{", start)
        body = lib[brace : guard.match_delimiter(lib, brace, "{", "}")]
        declared = re.findall(r"\bpub fn\s+(\w+)\s*\(", body)
        parsed = [function["name"] for function in self.contract["functions"]]
        self.assertEqual(parsed, declared)
        constructor = next(f for f in self.contract["functions"] if f["name"] == "__constructor")
        self.assertEqual(constructor["returns"], "void")
        self.assertEqual([arg["name"] for arg in constructor["args"]], ["governor"])
        self.assertNotIn("__constructor", self.spec_operations)

    def test_reviewed_entrypoints_are_present(self) -> None:
        """Entrypoints the #195 review named as missing must stay covered."""
        reviewed = {
            "create_streams",
            "schedule_stream",
            "execute_scheduled",
            "cancel_scheduled",
            "reclaim_expired",
            "set_fee_bps",
            "withdraw_treasury",
            "treasury_status",
            "nominate_governor",
            "accept_governor",
            "propose_upgrade",
            "execute_upgrade",
            "set_frozen",
            "create_stream_with_oracle",
            "resolve_time",
        }
        policy = {name for name in self.contract_operations if name.startswith("policy_")}
        self.assertGreaterEqual(len(policy), 11)
        self.assertEqual(sorted((reviewed | policy) - self.spec_operations), [])
        events = {event["name"] for event in self.spec["events"]}
        self.assertTrue({"StreamsCreated", "FeeCharged"} <= events)

    def test_events_match_the_canonical_event_registry(self) -> None:
        registry = json.loads(REGISTRY_PATH.read_text())["events"]
        spec_events = {event["name"]: event for event in self.spec["events"]}
        self.assertEqual(sorted(spec_events), sorted(registry))
        for name, entry in registry.items():
            event = spec_events[name]
            with self.subTest(event=name):
                self.assertEqual(event["topic"], entry["event_key"])
                for registry_key, spec_key in (("topics", "topicFields"), ("data", "dataFields")):
                    self.assertEqual(
                        [(f["name"], f["type"]) for f in event[spec_key]],
                        [(f["name"], guard.parse_type(f["type"])) for f in entry[registry_key]],
                    )

    def test_shared_types_match_the_canonical_event_registry(self) -> None:
        definitions = json.loads(REGISTRY_PATH.read_text())["definitions"]
        for name, entry in definitions.items():
            with self.subTest(type=name):
                self.assertEqual(canonical(self.spec, name), entry["canonical"])

    def test_read_only_classification_is_current(self) -> None:
        names = {function["name"] for function in self.contract["functions"]}
        self.assertEqual(sorted(guard.READ_ONLY - names), [], "READ_ONLY names a removed entrypoint")
        for function in self.contract["functions"]:
            if function["doc"].lower().startswith(("read-only", "reads ", "returns ", "queries ")):
                with self.subTest(entrypoint=function["name"]):
                    self.assertIn(function["name"], guard.READ_ONLY)

    def test_unit_enums_record_their_wire_encoding(self) -> None:
        for enum in self.spec["enums"]:
            self.assertIn(enum["encoding"], ("symbol", "u32"))
        # StreamStatus has no explicit discriminants, so Soroban encodes it as
        # `Vec[Symbol(case)]`, never as a u32.
        status = next(e for e in self.spec["enums"] if e["name"] == "StreamStatus")
        self.assertEqual(status["encoding"], "symbol")

    def test_spec_is_exactly_what_the_parser_emits(self) -> None:
        """`--write-spec` must be a no-op on a clean tree."""
        self.assertEqual(
            guard.format_spec(self.spec),
            guard.format_spec(self.expected),
            "streampay.spec.json is stale; run check_contract_surface.py --write-spec",
        )

    def test_spec_matches_the_contract_surface(self) -> None:
        self.assertEqual(guard.compare(self.spec, self.expected), [])

    def test_fingerprint_matches_the_spec(self) -> None:
        recorded = guard.FINGERPRINT_PATH.read_text().strip()
        self.assertEqual(recorded, guard.fingerprint(self.spec))


if __name__ == "__main__":
    unittest.main()
