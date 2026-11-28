"""Properties of the generated read-only Python client."""
from __future__ import annotations

import ast
import json
import re
import unittest
from dataclasses import replace

import check_contract_surface as guard
import emit_python_readonly as readonly_emitter
import generate
import ir


class PythonEmitterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = json.loads(guard.SPEC_PATH.read_text(encoding="utf-8"))
        cls.fingerprint = guard.fingerprint(cls.spec)
        cls.errors = generate.load_error_catalog()
        cls.outputs = readonly_emitter.outputs(cls.spec, cls.fingerprint, cls.errors)
        cls.generated = next(
            text for path, text in cls.outputs.items() if path.name == "_generated.py"
        )
        cls.tree = ast.parse(cls.generated)
        cls.read_only = readonly_emitter.read_functions(cls.spec)
        cls.mutating = [
            function for function in cls.spec["functions"] if function["mutating"]
        ]

    def test_every_read_operation_has_builder_decoder_and_client_method(self) -> None:
        definitions = {
            node.name for node in self.tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
        }
        client = next(
            node for node in self.tree.body
            if isinstance(node, ast.ClassDef) and node.name == "ReadClient"
        )
        methods = {node.name for node in client.body if isinstance(node, ast.FunctionDef)}
        for function in self.read_only:
            name = function["name"]
            with self.subTest(operation=name):
                self.assertIn(f"{name}_args", definitions)
                self.assertIn(f"decode_{name}_result", definitions)
                self.assertIn(name, methods)
                self.assertIn(f"{name.upper()} = {name!r}", self.generated)

    def test_client_exposes_only_read_operations(self) -> None:
        client = next(
            node for node in self.tree.body
            if isinstance(node, ast.ClassDef) and node.name == "ReadClient"
        )
        methods = {node.name for node in client.body if isinstance(node, ast.FunctionDef)}
        self.assertEqual(
            methods,
            {"__init__", "_call", *(function["name"] for function in self.read_only)},
        )
        for function in self.mutating:
            name = function["name"]
            with self.subTest(operation=name):
                self.assertNotIn(f"def {name}_args(", self.generated)
                self.assertNotIn(f"def decode_{name}_result(", self.generated)
                self.assertNotIn(f"{name.upper()} = {name!r}", self.generated)

    def test_every_event_has_a_typed_class_and_dispatch_case(self) -> None:
        classes = {
            node.name for node in self.tree.body if isinstance(node, ast.ClassDef)
        }
        for event in self.spec["events"]:
            with self.subTest(event=event["name"]):
                self.assertIn(event["name"], classes)
                self.assertIn(
                    f"if topic.value == {event['topic']!r}:", self.generated
                )
                self.assertIn(
                    f"return {event['name']}.from_parts(event, {event['name']!r})",
                    self.generated,
                )

    def test_event_decoder_requires_and_checks_the_contract_id(self) -> None:
        decoder = next(
            node for node in self.tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "decode_stream_pay_event"
        )
        self.assertEqual(
            [argument.arg for argument in decoder.args.args],
            ["encoded", "contract_id"],
        )
        self.assertIn("event.contract_id.lower() != contract_id.lower()", self.generated)

    def test_error_enum_matches_the_canonical_catalog(self) -> None:
        error_class = next(
            node for node in self.tree.body
            if isinstance(node, ast.ClassDef) and node.name == "StreamError"
        )
        variants = {
            node.targets[0].id: ast.literal_eval(node.value)
            for node in error_class.body
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
        }
        self.assertEqual(variants, {name: code for code, name in self.errors})

    def test_generated_source_compiles_and_top_level_names_are_unique(self) -> None:
        compile(self.generated, "_generated.py", "exec")
        names: list[str] = []
        for node in self.tree.body:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                names.append(node.name)
            elif isinstance(node, ast.Assign):
                names.extend(
                    target.id for target in node.targets if isinstance(target, ast.Name)
                )
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                names.append(node.target.id)
        duplicates = sorted({name for name in names if names.count(name) > 1})
        self.assertEqual(duplicates, [])

    def test_generated_source_is_fresh_and_fingerprinted(self) -> None:
        self.assertEqual(len(self.outputs), 1)
        path, text = next(iter(self.outputs.items()))
        self.assertEqual(path, readonly_emitter.PACKAGE_DIR / "src" / "streampay" / "_generated.py")
        self.assertEqual(path.read_text(encoding="utf-8"), text)
        self.assertIn(f"SPEC_FINGERPRINT = {self.fingerprint!r}", text)
        self.assertIn(
            f"CONTRACT_VERSION = {self.spec['contract']['version']!r}", text
        )

    def test_supplied_ir_is_rendered_without_reloading_the_canonical_spec(self) -> None:
        parsed = ir.parse_spec(self.spec)
        self.assertEqual(
            readonly_emitter.outputs(parsed, self.fingerprint, self.errors),
            self.outputs,
        )
        changed = replace(parsed, contract=replace(parsed.contract, version="9.9.9"))
        generated = next(iter(readonly_emitter.outputs(changed, "synthetic", self.errors).values()))
        self.assertIn("SPEC_FINGERPRINT = 'synthetic'", generated)
        self.assertIn("CONTRACT_VERSION = '9.9.9'", generated)

    def test_package_version_matches_spec_and_has_no_runtime_dependencies(self) -> None:
        text = (readonly_emitter.PACKAGE_DIR / "pyproject.toml").read_text(encoding="utf-8")
        project = text.split("[project]", 1)[1].split("\n[", 1)[0]
        version = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)
        dependencies = re.search(r"^dependencies\s*=\s*(\[[^\]]*\])", project, re.MULTILINE)
        self.assertIsNotNone(version)
        self.assertIsNotNone(dependencies)
        self.assertEqual(version.group(1), self.spec["contract"]["version"])
        self.assertEqual(ast.literal_eval(dependencies.group(1)), [])


if __name__ == "__main__":
    unittest.main()
