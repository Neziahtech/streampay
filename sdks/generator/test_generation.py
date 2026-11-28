"""Determinism, artifact fingerprinting, and freshness-gate tests."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate  # noqa: E402
import ir  # noqa: E402

ARTIFACTS = {
    "sdks/python/src/streampay/_generated.py",
    "sdks/python/streampay/_generated.py",
    "sdks/rust/src/generated.rs",
    "sdks/typescript/src/generated.ts",
    "sdks/typescript/src/methods.ts",
}
MANIFEST = "sdks/generator/GENERATED_FINGERPRINT"


class GenerationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = generate.load_spec()
        cls.targets = generate.outputs(cls.spec)

    def relative_targets(self, root: Path) -> dict[Path, str]:
        return {
            root / path.relative_to(generate.ROOT): content
            for path, content in self.targets.items()
        }

    def test_all_declared_emitter_packages_are_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "emit_missing.py").write_text("", encoding="utf-8")
            module = mock.Mock(PACKAGE_DIR=root / "missing-package")
            with mock.patch.object(generate, "HERE", root), mock.patch.object(
                generate.importlib, "import_module", return_value=module
            ):
                with self.assertRaisesRegex(ValueError, "missing package"):
                    generate.emitters()

    def test_every_language_artifact_is_emitted(self) -> None:
        ordered = [path.relative_to(generate.ROOT).as_posix() for path in self.targets]
        self.assertEqual(set(ordered), ARTIFACTS)
        self.assertEqual(
            ordered,
            sorted(ordered),
            "outputs must have deterministic relative-POSIX ordering",
        )

    def test_reruns_are_byte_identical(self) -> None:
        rerun = generate.outputs(self.spec)
        self.assertEqual(list(rerun), list(self.targets))
        for path, content in self.targets.items():
            with self.subTest(artifact=path.name):
                self.assertEqual(content, rerun[path])
                self.assertEqual(content.encode("utf-8"), path.read_bytes())

    def test_manifest_is_sorted_and_hashes_every_artifact(self) -> None:
        manifest_text = generate.generation_manifest(
            self.targets, self.spec.fingerprint
        )
        manifest = json.loads(manifest_text)
        self.assertEqual(manifest["schema"], "streampay-generation/v1")
        self.assertEqual(manifest["specFingerprint"], self.spec.fingerprint)
        self.assertEqual(
            [item["path"] for item in manifest["artifacts"]], sorted(ARTIFACTS)
        )
        self.assertEqual(
            manifest["sha256"],
            generate.generation_fingerprint(self.targets, self.spec.fingerprint),
        )
        self.assertEqual(manifest_text, generate.generation_manifest(self.targets, self.spec.fingerprint))

    def test_every_artifact_affects_the_generation_fingerprint(self) -> None:
        baseline = generate.generation_fingerprint(self.targets, self.spec.fingerprint)
        for path, content in self.targets.items():
            with self.subTest(artifact=path.relative_to(generate.ROOT).as_posix()):
                changed = dict(self.targets)
                changed[path] = content + "\n# intentional drift\n"
                self.assertNotEqual(
                    baseline,
                    generate.generation_fingerprint(changed, self.spec.fingerprint),
                )
        self.assertNotEqual(
            baseline,
            generate.generation_fingerprint(self.targets, "0" * 64),
        )

    def test_fingerprint_is_independent_of_host_checkout_path(self) -> None:
        with tempfile.TemporaryDirectory() as left, tempfile.TemporaryDirectory() as right:
            left_root = Path(left)
            right_root = Path(right)
            left_targets = self.relative_targets(left_root)
            right_targets = self.relative_targets(right_root)
            self.assertEqual(
                generate.generation_fingerprint(left_targets, self.spec.fingerprint, left_root),
                generate.generation_fingerprint(right_targets, self.spec.fingerprint, right_root),
            )

    def test_writes_are_exact_utf8_lf_and_repeatable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = self.relative_targets(root)
            generate.write_outputs(targets, self.spec.fingerprint, root)
            first = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path, content in generate._all_outputs(
                    targets, self.spec.fingerprint, root
                ).items()
            }
            generate.write_outputs(targets, self.spec.fingerprint, root)
            second = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path, content in generate._all_outputs(
                    targets, self.spec.fingerprint, root
                ).items()
            }
            self.assertEqual(first, second)
            for relative, raw in first.items():
                with self.subTest(artifact=relative):
                    self.assertNotIn(b"\r", raw)
                    raw.decode("utf-8")
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root), []
            )

    def test_crlf_and_intentional_drift_fail_the_freshness_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = self.relative_targets(root)
            generate.write_outputs(targets, self.spec.fingerprint, root)
            artifact = root / "sdks/python/streampay/_generated.py"
            artifact.write_bytes(artifact.read_bytes().replace(b"\n", b"\r\n"))
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root),
                ["sdks/python/streampay/_generated.py"],
            )

            generate.write_outputs(targets, self.spec.fingerprint, root)
            artifact.write_bytes(artifact.read_bytes() + b"\n# intentional drift\n")
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root),
                ["sdks/python/streampay/_generated.py"],
            )

    def test_manifest_drift_and_missing_artifacts_fail_the_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = self.relative_targets(root)
            generate.write_outputs(targets, self.spec.fingerprint, root)
            manifest = root / MANIFEST
            manifest.write_bytes(manifest.read_bytes() + b" ")
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root), [MANIFEST]
            )

            generate.write_outputs(targets, self.spec.fingerprint, root)
            manifest.unlink()
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root), [MANIFEST]
            )

            generate.write_outputs(targets, self.spec.fingerprint, root)
            missing = root / "sdks/rust/src/generated.rs"
            missing.unlink()
            self.assertEqual(
                generate.check_outputs(targets, self.spec.fingerprint, root),
                ["sdks/rust/src/generated.rs"],
            )

    def test_spec_crlf_and_utf8_text_do_not_change_emitted_bytes(self) -> None:
        text = ir.SPEC_PATH.read_text(encoding="utf-8")
        crlf = ir.parse_spec(text.replace("\n", "\r\n"))
        self.assertEqual(crlf, self.spec)
        self.assertIn("—", text)
        self.assertEqual(generate.outputs(crlf), self.targets)


if __name__ == "__main__":
    unittest.main()
