"""Tests for the validated, immutable specification IR."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ir  # noqa: E402


def minimal_spec() -> dict:
    return {
        "schema": "streampay-spec/v3",
        "generator": "sdks/generator/generate.py",
        "contract": {
            "name": "Demo",
            "crate": "demo",
            "version": "1.0.0",
            "description": "Synthetic IR fixture — Σ",
        },
        "constants": {"MAX_DEMOS": {"value": 7, "type": "u32"}},
        "functions": [
            {
                "name": "read_demo",
                "doc": "Reads a demo — Σ.",
                "mutating": False,
                "args": [{"name": "id", "type": "u64", "doc": ""}],
                "returns": {"result": {"ok": "DemoPayload", "err": "StreamError"}},
            },
            {
                "name": "write_other",
                "doc": "",
                "mutating": True,
                "args": [],
                "returns": "Other",
            },
        ],
        "structs": [
            {
                "name": "Demo",
                "fields": [{"name": "state", "type": "DemoState", "doc": ""}],
            },
            {
                "name": "Other",
                "fields": [{"name": "state", "type": "OtherState", "doc": ""}],
            },
        ],
        "enums": [
            {
                "name": "DemoState",
                "encoding": "symbol",
                "cases": [{"name": "Ready"}],
            },
            {
                "name": "OtherState",
                "encoding": "u32",
                "cases": [{"name": "Idle", "value": 0}],
            },
        ],
        "unions": [
            {
                "name": "DemoPayload",
                "cases": [
                    {"name": "Amount", "types": ["Demo"]},
                    {"name": "Empty", "types": []},
                ],
            }
        ],
        "events": [
            {
                "name": "DemoHappened",
                "topic": "demo_happened",
                "doc": "",
                "topicFields": [{"name": "id", "type": "u64", "doc": ""}],
                "dataFields": [],
            }
        ],
    }


class IRParsingTest(unittest.TestCase):
    def test_canonical_spec_counts_and_fingerprint(self) -> None:
        spec = ir.load_spec()
        self.assertEqual(spec.schema, "streampay-spec/v3")
        self.assertEqual(len(spec.functions), 136)
        self.assertEqual(len(spec.read_functions), 44)
        self.assertEqual(len(spec.structs), 45)
        self.assertEqual(len(spec.enums), 8)
        self.assertEqual(len(spec.unions), 3)
        self.assertEqual(len(spec.events), 71)
        self.assertEqual(len(spec.constants), 41)
        self.assertEqual(
            spec.fingerprint,
            "a8f57f714c63aef15611f45fae838ea739f7987260778d78dda41847cbb800bc",
        )
        self.assertIs(ir.parse_spec(spec), spec)

    def test_mapping_text_and_utf8_bytes_parse_identically(self) -> None:
        raw = minimal_spec()
        text = json.dumps(raw, ensure_ascii=False)
        self.assertEqual(ir.parse_spec(raw), ir.parse_spec(text))
        self.assertEqual(ir.parse_spec(raw), ir.parse_spec(text.encode("utf-8")))
        self.assertEqual(ir.parse_spec(raw).contract.description, "Synthetic IR fixture — Σ")

    def test_ir_values_are_frozen_and_ordered(self) -> None:
        spec = ir.parse_spec(minimal_spec())
        with self.assertRaises(FrozenInstanceError):
            spec.contract.version = "changed"  # type: ignore[misc]
        with self.assertRaises(FrozenInstanceError):
            spec.functions[0].mutating = True  # type: ignore[misc]
        self.assertIsInstance(spec.functions, tuple)
        self.assertIsInstance(spec.functions[0].args, tuple)
        self.assertEqual(spec.function("read_demo").returns.label, "result:DemoPayload")
        self.assertEqual(spec.event("demo_happened").name, "DemoHappened")

    def test_reachable_type_closure_is_ordered_and_read_only(self) -> None:
        spec = ir.parse_spec(minimal_spec())
        structs, enums, unions = spec.reachable_types(read_only=True)
        self.assertEqual([item.name for item in structs], ["Demo"])
        self.assertEqual([item.name for item in enums], ["DemoState"])
        self.assertEqual([item.name for item in unions], ["DemoPayload"])
        all_structs, all_enums, _ = spec.reachable_types()
        self.assertEqual([item.name for item in all_structs], ["Demo", "Other"])
        self.assertEqual([item.name for item in all_enums], ["DemoState", "OtherState"])

    def test_unknown_fields_and_undefined_types_are_rejected(self) -> None:
        raw = minimal_spec()
        raw["unexpected"] = True
        with self.assertRaisesRegex(ir.SpecError, "unknown field"):
            ir.parse_spec(raw)

        raw = minimal_spec()
        raw["structs"][0]["fields"][0]["type"] = "Missing"
        with self.assertRaisesRegex(ir.SpecError, "undefined type"):
            ir.parse_spec(raw)

    def test_duplicate_declarations_are_rejected(self) -> None:
        cases = []

        raw = minimal_spec()
        raw["functions"].append(copy.deepcopy(raw["functions"][0]))
        cases.append(("operation", raw))

        raw = minimal_spec()
        raw["structs"].append(copy.deepcopy(raw["structs"][0]))
        cases.append(("type", raw))

        raw = minimal_spec()
        raw["structs"][0]["fields"].append(copy.deepcopy(raw["structs"][0]["fields"][0]))
        cases.append(("field", raw))

        raw = minimal_spec()
        raw["enums"][0]["cases"].append(copy.deepcopy(raw["enums"][0]["cases"][0]))
        cases.append(("case", raw))

        raw = minimal_spec()
        raw["events"].append(copy.deepcopy(raw["events"][0]))
        cases.append(("event", raw))

        for label, raw in cases:
            with self.subTest(duplicate=label):
                with self.assertRaisesRegex(ir.SpecError, "duplicate"):
                    ir.parse_spec(raw)

    def test_integer_and_enum_discriminants_are_validated(self) -> None:
        raw = minimal_spec()
        raw["constants"]["MAX_DEMOS"]["value"] = 1 << 32
        with self.assertRaisesRegex(ir.SpecError, "outside the u32 range"):
            ir.parse_spec(raw)

        raw = minimal_spec()
        raw["enums"][1]["cases"][0].pop("value")
        with self.assertRaisesRegex(ir.SpecError, "needs a u32 discriminant"):
            ir.parse_spec(raw)

        raw = minimal_spec()
        raw["enums"][1]["cases"].append({"name": "Busy", "value": 0})
        with self.assertRaisesRegex(ir.SpecError, "duplicate discriminant"):
            ir.parse_spec(raw)

    def test_result_errors_and_void_arguments_are_rejected(self) -> None:
        raw = minimal_spec()
        raw["functions"][0]["returns"]["result"]["err"] = "u32"
        with self.assertRaisesRegex(ir.SpecError, "invalid result payload"):
            ir.parse_spec(raw)

        raw = minimal_spec()
        raw["functions"][0]["args"][0]["type"] = "void"
        with self.assertRaisesRegex(ir.SpecError, "cannot be void"):
            ir.parse_spec(raw)

    def test_results_are_allowed_only_in_return_containers(self) -> None:
        result_type = {"result": {"ok": "u32", "err": "StreamError"}}
        placements = []

        raw = minimal_spec()
        raw["functions"][0]["args"][0]["type"] = copy.deepcopy(result_type)
        placements.append(("argument", raw))

        raw = minimal_spec()
        raw["structs"][0]["fields"][0]["type"] = copy.deepcopy(result_type)
        placements.append(("struct field", raw))

        raw = minimal_spec()
        raw["unions"][0]["cases"][0]["types"] = [copy.deepcopy(result_type)]
        placements.append(("union payload", raw))

        raw = minimal_spec()
        raw["events"][0]["topicFields"][0]["type"] = copy.deepcopy(result_type)
        placements.append(("event field", raw))

        raw = minimal_spec()
        raw["structs"][0]["fields"][0]["type"] = {"vec": copy.deepcopy(result_type)}
        placements.append(("nested argument value", raw))

        for label, raw in placements:
            with self.subTest(placement=label):
                with self.assertRaisesRegex(ir.SpecError, "return-only"):
                    ir.parse_spec(raw)

        raw = minimal_spec()
        raw["functions"][0]["returns"] = {"vec": copy.deepcopy(result_type)}
        self.assertEqual(
            ir.parse_spec(raw).functions[0].returns.label,
            "vec:result:u32",
        )

        unsupported_returns = [
            {"option": copy.deepcopy(result_type)},
            {"vec": {"vec": copy.deepcopy(result_type)}},
            {"vec": {"option": copy.deepcopy(result_type)}},
        ]
        for return_type in unsupported_returns:
            with self.subTest(return_type=return_type):
                raw = minimal_spec()
                raw["functions"][0]["returns"] = return_type
                with self.assertRaisesRegex(ir.SpecError, "return-only"):
                    ir.parse_spec(raw)

    def test_unsupported_schema_and_invalid_json_are_rejected(self) -> None:
        raw = minimal_spec()
        raw["schema"] = "streampay-spec/v2"
        with self.assertRaisesRegex(ir.SpecError, "unsupported spec schema"):
            ir.parse_spec(raw)
        with self.assertRaisesRegex(ir.SpecError, "invalid spec JSON"):
            ir.parse_spec("{")


if __name__ == "__main__":
    unittest.main()
