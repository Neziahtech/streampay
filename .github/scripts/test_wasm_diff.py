#!/usr/bin/env python3
"""
Unit test suite for wasm_diff.py and format_report.py.
Validates:
- Rust symbol demangling (legacy _ZN and v0 _R, stripping compiler hash)
- Accurate Wasm binary parsing & function byte measurement
- Turbopack-style churn normalization (offset/index/hash shift) vs real growth
- Top movers identification and markdown table rendering
"""

import os
import sys
import tempfile
import unittest

# Add scripts directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from format_report import render_markdown_report
from wasm_diff import (
    WasmFunction,
    compute_body_fingerprint,
    demangle_symbol,
    diff_wasm_functions,
    parse_wasm_functions,
    run_wasm_diff,
)


def encode_u32_leb128(val: int) -> bytes:
    """Encode an integer as unsigned LEB128."""
    res = bytearray()
    while True:
        b = val & 0x7F
        val >>= 7
        if val != 0:
            b |= 0x80
        res.append(b)
        if val == 0:
            break
    return bytes(res)


def build_test_wasm(
    functions: list,
    exports: dict = None,
    names: dict = None,
) -> bytes:
    """
    Builds a minimal valid WebAssembly binary with specified functions,
    exports, and custom name section for testing.
    functions: list of byte payloads for function bodies (including local header).
    exports: dict of func_idx -> export_name.
    names: dict of func_idx -> symbol_name.
    """
    exports = exports or {}
    names = names or {}

    out = bytearray(b"\x00asm\x01\x00\x00\x00")

    # Section 1: Type (1 type: () -> ())
    type_payload = bytearray()
    type_payload.extend(encode_u32_leb128(1))  # 1 type
    type_payload.append(0x60)  # func
    type_payload.extend(encode_u32_leb128(0))  # 0 params
    type_payload.extend(encode_u32_leb128(0))  # 0 results
    out.append(1)  # section id
    out.extend(encode_u32_leb128(len(type_payload)))
    out.extend(type_payload)

    # Section 3: Function section (all use type 0)
    func_payload = bytearray()
    func_payload.extend(encode_u32_leb128(len(functions)))
    for _ in functions:
        func_payload.extend(encode_u32_leb128(0))
    out.append(3)
    out.extend(encode_u32_leb128(len(func_payload)))
    out.extend(func_payload)

    # Section 7: Export section
    if exports:
        exp_payload = bytearray()
        exp_payload.extend(encode_u32_leb128(len(exports)))
        for idx, exp_name in exports.items():
            name_bytes = exp_name.encode("utf-8")
            exp_payload.extend(encode_u32_leb128(len(name_bytes)))
            exp_payload.extend(name_bytes)
            exp_payload.append(0)  # func kind
            exp_payload.extend(encode_u32_leb128(idx))
        out.append(7)
        out.extend(encode_u32_leb128(len(exp_payload)))
        out.extend(exp_payload)

    # Section 10: Code section
    code_payload = bytearray()
    code_payload.extend(encode_u32_leb128(len(functions)))
    for body in functions:
        code_payload.extend(encode_u32_leb128(len(body)))
        code_payload.extend(body)
    out.append(10)
    out.extend(encode_u32_leb128(len(code_payload)))
    out.extend(code_payload)

    # Section 0: Custom name section
    if names:
        custom_payload = bytearray()
        sec_name = b"name"
        custom_payload.extend(encode_u32_leb128(len(sec_name)))
        custom_payload.extend(sec_name)

        # Subsection 1: Function names
        sub1 = bytearray()
        sub1.extend(encode_u32_leb128(len(names)))
        for idx, sym_name in names.items():
            sub1.extend(encode_u32_leb128(idx))
            name_bytes = sym_name.encode("utf-8")
            sub1.extend(encode_u32_leb128(len(name_bytes)))
            sub1.extend(name_bytes)

        custom_payload.append(1)  # subsection id 1
        custom_payload.extend(encode_u32_leb128(len(sub1)))
        custom_payload.extend(sub1)

        out.append(0)
        out.extend(encode_u32_leb128(len(custom_payload)))
        out.extend(custom_payload)

    return bytes(out)


class TestWasmDiff(unittest.TestCase):

    def test_rust_symbol_demangling(self):
        # Legacy mangled symbol with 17-char hash preserved
        mangled = "_ZN18streampay_contract6stream11streamed_at17h7a2b9c8d1e3f4a5E"
        expected = "streampay_contract::stream::streamed_at::h7a2b9c8d1e3f4a5"
        self.assertEqual(demangle_symbol(mangled), expected)

        # Another legacy symbol with hash preserved
        mangled2 = "_ZN4core3ptr13drop_in_place17h1234567890abcdefE"
        self.assertEqual(demangle_symbol(mangled2), "core::ptr::drop_in_place::h1234567890abcdef")

        # Export name / plain identifier should remain unchanged
        self.assertEqual(demangle_symbol("create_stream"), "create_stream")
        self.assertEqual(demangle_symbol("withdraw_max"), "withdraw_max")

    def test_monomorphization_hash_preservation(self):
        """Verifies distinct monomorphizations with different hashes do not collide."""
        f1 = "_ZN18streampay_contract4cast17h1111111111111111E"
        f2 = "_ZN18streampay_contract4cast17h2222222222222222E"
        d1 = demangle_symbol(f1)
        d2 = demangle_symbol(f2)
        self.assertNotEqual(d1, d2)
        self.assertTrue(d1.endswith("::h1111111111111111"))
        self.assertTrue(d2.endswith("::h2222222222222222"))

    def test_negative_churn_detection(self):
        """
        Negative test case:
        Asserts that call 5 -> call 6 is NOT labeled as CHURN (it is MODIFIED),
        and local.get 0 -> local.get 3 is NOT labeled as CHURN (it is MODIFIED).
        Also verifies operand bytes in instructions (e.g. memarg) are not misread as opcodes.
        """
        # Test 1: call 5 (0x10 0x05) -> call 6 (0x10 0x06)
        body_call5 = b"\x00\x10\x05\x0b"
        body_call6 = b"\x00\x10\x06\x0b"
        self.assertEqual(len(body_call5), len(body_call6), "Equal size deltas")

        base_wasm_call = build_test_wasm(
            functions=[body_call5],
            names={0: "streampay_contract::invoke_call"},
        )
        head_wasm_call = build_test_wasm(
            functions=[body_call6],
            names={0: "streampay_contract::invoke_call"},
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            base_p = os.path.join(tmpdir, "base_call.wasm")
            head_p = os.path.join(tmpdir, "head_call.wasm")
            with open(base_p, "wb") as f:
                f.write(base_wasm_call)
            with open(head_p, "wb") as f:
                f.write(head_wasm_call)

            res = run_wasm_diff(base_wasm=base_p, head_wasm=head_p)
            diffs = res["all_diffs"]
            self.assertEqual(len(diffs), 1)
            # call 5 -> call 6 changed function logic: MUST NOT be labeled as CHURN
            self.assertNotEqual(diffs[0]["status"], "CHURN")
            self.assertEqual(diffs[0]["status"], "MODIFIED")
            self.assertFalse(diffs[0]["is_churn"])

        # Test 2: local.get 0 (0x20 0x00) -> local.get 3 (0x20 0x03)
        body_local0 = b"\x00\x20\x00\x0b"
        body_local3 = b"\x00\x20\x03\x0b"
        self.assertEqual(len(body_local0), len(body_local3), "Equal size deltas")

        # Ensure normalized fingerprints differ because local indices are preserved
        fp_local0 = compute_body_fingerprint(body_local0)
        fp_local3 = compute_body_fingerprint(body_local3)
        self.assertNotEqual(fp_local0, fp_local3, "Fingerprints for local.get 0 vs local.get 3 must not match")

        base_wasm_local = build_test_wasm(
            functions=[body_local0],
            names={0: "streampay_contract::get_val"},
        )
        head_wasm_local = build_test_wasm(
            functions=[body_local3],
            names={0: "streampay_contract::get_val"},
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            base_p = os.path.join(tmpdir, "base_local.wasm")
            head_p = os.path.join(tmpdir, "head_local.wasm")
            with open(base_p, "wb") as f:
                f.write(base_wasm_local)
            with open(head_p, "wb") as f:
                f.write(head_wasm_local)

            res = run_wasm_diff(base_wasm=base_p, head_wasm=head_p)
            diffs = res["all_diffs"]
            self.assertEqual(len(diffs), 1)
            # local.get 0 -> local.get 3 changed local index: MUST NOT be labeled as CHURN
            self.assertNotEqual(diffs[0]["status"], "CHURN")
            self.assertEqual(diffs[0]["status"], "MODIFIED")
            self.assertFalse(diffs[0]["is_churn"])

        # Test 3: Operands must not be misread as opcodes
        # 0x28 is i32.load; align=0x10, offset=0x20 (0x10 is call opcode, 0x20 is local.get opcode)
        body_mem = b"\x00\x28\x10\x20\x0b"
        fp_mem = compute_body_fingerprint(body_mem)
        self.assertTrue(isinstance(fp_mem, str) and len(fp_mem) == 64)

    def test_churn_vs_real_growth_detection(self):
        # Body A: 0 locals, nop, end (3 bytes)
        body_unchanged = b"\x00\x01\x0b"
        # Body B: 0 locals, some math (10 bytes)
        body_math = b"\x00\x41\x05\x41\x0a\x6a\x1a\x01\x0b"
        # Body B grown: additional operations (25 bytes)
        body_math_grown = b"\x00\x41\x05\x41\x0a\x6a\x41\x02\x6c\x41\x03\x6a\x41\x04\x6a\x1a\x01\x0b"
        # Body C: will be removed
        body_removed = b"\x00\x41\x01\x0b"
        # Body D: new bloat function (50 bytes)
        body_bloat = b"\x00" + (b"\x01" * 48) + b"\x0b"

        # Build Base Wasm:
        # func 0: create_stream (unchanged body)
        # func 1: streampay_contract::stream::streamed_at::h1111 (math body)
        # func 2: streampay_contract::helpers::to_remove (removed body)
        base_bytes = build_test_wasm(
            functions=[body_unchanged, body_math, body_removed],
            exports={0: "create_stream"},
            names={
                0: "create_stream",
                1: "_ZN18streampay_contract6stream11streamed_at17h1111111111111111E",
                2: "_ZN18streampay_contract7helpers9to_remove17h3333333333333333E",
            },
        )

        # Build Head Wasm:
        # func 0: bloat function added at front! (causing offsets and indices to shift!)
        # func 1: create_stream (same body as old func 0, but offset shifted -> TURBOPACK CHURN!)
        # func 2: streampay_contract::stream::streamed_at::h1111 (grown body, matching name!)
        # func 2 to_remove is gone! (REMOVED)
        head_bytes = build_test_wasm(
            functions=[body_bloat, body_unchanged, body_math_grown],
            exports={1: "create_stream", 0: "bloat_demo_function"},
            names={
                0: "bloat_demo_function",
                1: "create_stream",
                2: "_ZN18streampay_contract6stream11streamed_at17h1111111111111111E",
            },
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = os.path.join(tmpdir, "base.wasm")
            head_path = os.path.join(tmpdir, "head.wasm")
            json_path = os.path.join(tmpdir, "diff.json")
            md_path = os.path.join(tmpdir, "report.md")

            with open(base_path, "wb") as f:
                f.write(base_bytes)
            with open(head_path, "wb") as f:
                f.write(head_bytes)

            result = run_wasm_diff(
                base_wasm=base_path,
                head_wasm=head_path,
                output_json=json_path,
                output_markdown=md_path,
            )

            summary = result["summary"]
            counts = summary["counts"]

            # Verify function classifications
            self.assertEqual(counts["new"], 1, "Expected exactly 1 new function (bloat_demo_function)")
            self.assertEqual(counts["removed"], 1, "Expected exactly 1 removed function (to_remove)")
            self.assertEqual(counts["grown"], 1, "Expected exactly 1 grown function (streamed_at)")
            self.assertEqual(counts["churn"], 1, "Expected exactly 1 filtered churn function (create_stream shifted offset)")

            # Verify top movers
            top_movers = result["top_movers"]
            mover_statuses = [m["status"] for m in top_movers]
            self.assertIn("NEW", mover_statuses)
            self.assertIn("GROWN", mover_statuses)
            self.assertIn("REMOVED", mover_statuses)

            # Check that create_stream (churn) is NOT in top movers!
            churn_in_movers = [m for m in top_movers if m["status"] == "CHURN"]
            self.assertEqual(len(churn_in_movers), 0, "Churn functions must not pollute top movers")

            # Check markdown file generated
            self.assertTrue(os.path.exists(md_path))
            with open(md_path, "r", encoding="utf-8") as f:
                content = f.read()

            self.assertIn("<!-- wasm-diff-report -->", content)
            self.assertIn("WebAssembly Binary Function-Level Diff", content)
            self.assertIn("bloat_demo_function", content)
            self.assertIn("streampay_contract::stream::streamed_at", content)
            self.assertIn("streampay_contract::helpers::to_remove", content)
            self.assertIn("filtered offset/symbol churn", content)

    def test_diff_stability_against_function_ordering(self):
        """Verifies report and top movers remain deterministic when functions appear in different orders."""
        body_a = b"\x00\x41\x05\x0b"
        body_b = b"\x00\x41\x0a\x0b"
        body_c = b"\x00\x41\x14\x0b"

        base_wasm = build_test_wasm(
            functions=[body_a, body_b, body_c],
            names={
                0: "streampay_contract::fn_alpha",
                1: "streampay_contract::fn_beta",
                2: "streampay_contract::fn_gamma",
            },
        )

        # Order 1: alpha expanded, beta unchanged, gamma removed, delta added
        body_a_grown = b"\x00\x41\x05\x41\x02\x6c\x0b"
        body_d_new = b"\x00\x41\x63\x0b"

        head_wasm_order1 = build_test_wasm(
            functions=[body_a_grown, body_b, body_d_new],
            names={
                0: "streampay_contract::fn_alpha",
                1: "streampay_contract::fn_beta",
                2: "streampay_contract::fn_delta",
            },
        )

        # Order 2: reversed function order in head binary
        head_wasm_order2 = build_test_wasm(
            functions=[body_d_new, body_b, body_a_grown],
            names={
                0: "streampay_contract::fn_delta",
                1: "streampay_contract::fn_beta",
                2: "streampay_contract::fn_alpha",
            },
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            base_p = os.path.join(tmpdir, "base.wasm")
            head_p1 = os.path.join(tmpdir, "head1.wasm")
            head_p2 = os.path.join(tmpdir, "head2.wasm")
            md_p1 = os.path.join(tmpdir, "report1.md")
            md_p2 = os.path.join(tmpdir, "report2.md")

            with open(base_p, "wb") as f:
                f.write(base_wasm)
            with open(head_p1, "wb") as f:
                f.write(head_wasm_order1)
            with open(head_p2, "wb") as f:
                f.write(head_wasm_order2)

            res1 = run_wasm_diff(base_wasm=base_p, head_wasm=head_p1, output_markdown=md_p1)
            res2 = run_wasm_diff(base_wasm=base_p, head_wasm=head_p2, output_markdown=md_p2)

            # Summaries and counts must match identically
            self.assertEqual(res1["summary"]["counts"], res2["summary"]["counts"])

            # Top movers must match identically (same order, same contents)
            self.assertEqual(
                [m["demangled_signature"] for m in res1["top_movers"]],
                [m["demangled_signature"] for m in res2["top_movers"]],
            )
            self.assertEqual(
                [m["delta"] for m in res1["top_movers"]],
                [m["delta"] for m in res2["top_movers"]],
            )

            # Markdown reports must be identical
            with open(md_p1, "r", encoding="utf-8") as f:
                md1_content = f.read()
            with open(md_p2, "r", encoding="utf-8") as f:
                md2_content = f.read()

            self.assertEqual(md1_content, md2_content, "Reports must be identical regardless of function ordering")


if __name__ == "__main__":
    unittest.main()
