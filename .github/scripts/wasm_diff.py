#!/usr/bin/env python3
"""
WebAssembly (Wasm) Function-Level Binary Diffing & Normalization Tool
for CI Pull Request analysis.

Disassembles Wasm binaries, extracts function bodies, demangles symbols,
normalizes bytecode to distinguish offset/hash churn from real code changes,
and computes top movers by byte delta.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple


# ==============================================================================
# 1. Rust Symbol Demangling
# ==============================================================================

def demangle_symbol(name: str) -> str:
    """
    Demangles Rust symbols (legacy _ZN and v0 _R mangling) preserving
    hash suffixes (::h[0-9a-f]{16}) so that compiler monomorphizations
    do not collide.
    """
    if not name:
        return "unnamed_function"

    demangled = name

    # Legacy Rust mangling: _ZN...E
    if name.startswith("_ZN") and name.endswith("E"):
        demangled = _demangle_rust_legacy(name)
    # Rust v0 mangling: _R...
    elif name.startswith("_R"):
        demangled = _demangle_rust_v0(name)

    return demangled


def _demangle_rust_legacy(mangled: str) -> str:
    """Demangle Rust legacy ABI (_ZN...E) with segment decoding."""
    pos = 3
    end = len(mangled) - 1
    parts = []
    while pos < end:
        len_str = ""
        while pos < end and mangled[pos].isdigit():
            len_str += mangled[pos]
            pos += 1
        if not len_str:
            break
        length = int(len_str)
        part = mangled[pos : min(pos + length, end)]
        pos += length

        # Handle special replacements
        part = (part.replace("$SP$", "@")
                    .replace("$BP$", "*")
                    .replace("$RF$", "&")
                    .replace("$LT$", "<")
                    .replace("$GT$", ">")
                    .replace("$LP$", "(")
                    .replace("$RP$", ")")
                    .replace("$u20$", " ")
                    .replace("$u7b$", "{")
                    .replace("$u7d$", "}")
                    .replace("$C$", ","))
        parts.append(part)

    return "::".join(parts) if parts else mangled


def _demangle_rust_v0(mangled: str) -> str:
    """Basic demangling and cleanup for Rust v0 mangling (_R...)."""
    # For v0 mangling, strip _R and crate disambiguator Cs..._
    s = mangled[2:]
    s = re.sub(r'Cs[0-9a-zA-Z]+_', '', s)
    # Clean up identifiers
    parts = re.findall(r'[a-zA-Z_][a-zA-Z0-9_]*', s)
    filtered = [p for p in parts if len(p) > 1]
    return "::".join(filtered) if filtered else mangled


# ==============================================================================
# 2. WebAssembly Binary Parser (Zero external dependencies)
# ==============================================================================

class WasmParser:
    """
    Parses a WebAssembly binary directly to extract functions, exact Code
    section byte sizes, signatures, export names, and custom Name section symbols.
    """

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def read_byte(self) -> int:
        b = self.data[self.pos]
        self.pos += 1
        return b

    def read_bytes(self, n: int) -> bytes:
        b = self.data[self.pos : self.pos + n]
        self.pos += n
        return b

    def read_u32_leb128(self) -> int:
        result = 0
        shift = 0
        while True:
            byte = self.read_byte()
            result |= (byte & 0x7F) << shift
            if (byte & 0x80) == 0:
                break
            shift += 7
        return result

    def read_string(self) -> str:
        length = self.read_u32_leb128()
        raw = self.read_bytes(length)
        return raw.decode("utf-8", errors="replace")


@dataclass
class WasmFunction:
    index: int
    name: str
    demangled_name: str
    export_name: Optional[str]
    size: int
    offset: int
    signature: str
    raw_body: bytes
    disassembly: List[str] = field(default_factory=list)
    normalized_fingerprint: str = ""


def parse_wasm_functions(wasm_path: str) -> Tuple[List[WasmFunction], Dict[str, int]]:
    """
    Parses a Wasm binary and returns:
    1. A list of internal functions with exact byte sizes and metadata.
    2. General section statistics (total size, code section size, function count).
    """
    with open(wasm_path, "rb") as f:
        data = f.read()

    total_size = len(data)
    if len(data) < 8 or data[:4] != b"\x00asm":
        raise ValueError(f"File {wasm_path} is not a valid WebAssembly binary")

    parser = WasmParser(data)
    parser.pos = 8  # Skip magic and version

    types = []
    imported_funcs_count = 0
    internal_func_types = []
    exports = {}  # func_idx -> export_name
    function_names = {}  # func_idx -> symbol_name
    code_bodies = []  # list of (body_size, body_offset, raw_body_bytes)
    code_section_size = 0

    while parser.pos < len(data):
        section_id = parser.read_byte()
        section_size = parser.read_u32_leb128()
        section_end = parser.pos + section_size

        if section_id == 1:  # Type section
            num_types = parser.read_u32_leb128()
            for _ in range(num_types):
                form = parser.read_byte()  # 0x60 = func
                num_params = parser.read_u32_leb128()
                param_types = [parser.read_byte() for _ in range(num_params)]
                num_results = parser.read_u32_leb128()
                result_types = [parser.read_byte() for _ in range(num_results)]

                valtype_map = {0x7F: "i32", 0x7E: "i64", 0x7D: "f32", 0x7C: "f64", 0x70: "funcref", 0x6F: "externref"}
                params_str = ", ".join(valtype_map.get(t, f"0x{t:x}") for t in param_types)
                results_str = ", ".join(valtype_map.get(t, f"0x{t:x}") for t in result_types)
                sig = f"({params_str}) -> ({results_str})" if results_str else f"({params_str})"
                types.append(sig)

        elif section_id == 2:  # Import section
            num_imports = parser.read_u32_leb128()
            for _ in range(num_imports):
                mod = parser.read_string()
                field_name = parser.read_string()
                kind = parser.read_byte()
                if kind == 0:  # function import
                    type_idx = parser.read_u32_leb128()
                    imported_funcs_count += 1
                elif kind == 1:  # table
                    parser.read_byte()  # element type
                    # limits
                    lim_flags = parser.read_byte()
                    parser.read_u32_leb128()
                    if lim_flags & 1:
                        parser.read_u32_leb128()
                elif kind == 2:  # memory
                    lim_flags = parser.read_byte()
                    parser.read_u32_leb128()
                    if lim_flags & 1:
                        parser.read_u32_leb128()
                elif kind == 3:  # global
                    parser.read_byte()  # valtype
                    parser.read_byte()  # mutability

        elif section_id == 3:  # Function section
            num_funcs = parser.read_u32_leb128()
            for _ in range(num_funcs):
                type_idx = parser.read_u32_leb128()
                internal_func_types.append(type_idx)

        elif section_id == 7:  # Export section
            num_exports = parser.read_u32_leb128()
            for _ in range(num_exports):
                exp_name = parser.read_string()
                kind = parser.read_byte()
                idx = parser.read_u32_leb128()
                if kind == 0:  # function export
                    exports[idx] = exp_name

        elif section_id == 10:  # Code section
            code_section_size = section_size
            code_start_pos = parser.pos
            num_bodies = parser.read_u32_leb128()
            for _ in range(num_bodies):
                body_offset = parser.pos
                body_size = parser.read_u32_leb128()
                payload = parser.read_bytes(body_size)
                # Function total size in binary includes the LEB128 size prefix
                total_func_bytes = parser.pos - body_offset
                code_bodies.append((total_func_bytes, body_offset, payload))

        elif section_id == 0:  # Custom section (e.g. "name")
            name_sec_start = parser.pos
            custom_name = parser.read_string()
            if custom_name == "name":
                while parser.pos < section_end:
                    sub_id = parser.read_byte()
                    sub_size = parser.read_u32_leb128()
                    sub_end = parser.pos + sub_size
                    if sub_id == 1:  # Function names
                        name_count = parser.read_u32_leb128()
                        for _ in range(name_count):
                            fn_idx = parser.read_u32_leb128()
                            fn_name = parser.read_string()
                            function_names[fn_idx] = fn_name
                    else:
                        parser.pos = sub_end
            else:
                parser.pos = section_end
        else:
            parser.pos = section_end

    # Build function objects
    functions: List[WasmFunction] = []
    for i, (f_size, f_offset, raw_body) in enumerate(code_bodies):
        func_idx = imported_funcs_count + i
        type_idx = internal_func_types[i] if i < len(internal_func_types) else 0
        sig = types[type_idx] if type_idx < len(types) else "()"

        exp_name = exports.get(func_idx)
        raw_name = function_names.get(func_idx) or exp_name or f"func[{func_idx}]"
        demangled = demangle_symbol(raw_name) if raw_name != f"func[{func_idx}]" else (exp_name or f"func_{func_idx}{sig}")

        # Compute normalized bytecode fingerprint
        # Strip LEB128 local headers and normalize instructions
        norm_fp = compute_body_fingerprint(raw_body)

        func_obj = WasmFunction(
            index=func_idx,
            name=raw_name,
            demangled_name=demangled,
            export_name=exp_name,
            size=f_size,
            offset=f_offset,
            signature=sig,
            raw_body=raw_body,
            normalized_fingerprint=norm_fp,
        )
        functions.append(func_obj)

    stats = {
        "total_size": total_size,
        "code_section_size": code_section_size,
        "total_functions": len(functions),
        "imported_functions": imported_funcs_count,
    }

    return functions, stats


# ==============================================================================
# 3. Disassembly Normalization & Turbopack-Style Churn Detection
# ==============================================================================

def _read_u32_leb128_from_bytes(data: bytes, pos: int) -> Tuple[int, int]:
    """Reads u32 LEB128 from data starting at pos. Returns (val, new_pos)."""
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return result, pos
        shift += 7
    raise ValueError("Unexpected EOF reading u32 LEB128")


def _read_i32_leb128_from_bytes(data: bytes, pos: int) -> Tuple[bytes, int]:
    """Reads signed 32-bit LEB128, returning (raw_bytes, new_pos)."""
    start = pos
    while pos < len(data):
        b = data[pos]
        pos += 1
        if (b & 0x80) == 0:
            return data[start:pos], pos
    raise ValueError("Unexpected EOF reading i32 LEB128")


def _read_i64_leb128_from_bytes(data: bytes, pos: int) -> Tuple[bytes, int]:
    """Reads signed 64-bit LEB128, returning (raw_bytes, new_pos)."""
    start = pos
    while pos < len(data):
        b = data[pos]
        pos += 1
        if (b & 0x80) == 0:
            return data[start:pos], pos
    raise ValueError("Unexpected EOF reading i64 LEB128")


def compute_body_fingerprint(raw_body: bytes) -> str:
    """
    Computes a normalized SHA-256 fingerprint of the function body bytecode.
    Accurately decodes all WebAssembly opcodes and operands.
    Blanks ONLY the call target index for call (0x10, 0x12, 0xD2) instructions
    so that relocated call targets normalize without misreading operand bytes as opcodes.
    Does NOT blank local variable indices (local.get/set/tee).
    Fails loudly on malformed bytecode.
    """
    i = 0
    # Read local groups at start of function body
    local_groups, i = _read_u32_leb128_from_bytes(raw_body, i)
    for _ in range(local_groups):
        _, i = _read_u32_leb128_from_bytes(raw_body, i)  # count
        if i >= len(raw_body):
            raise ValueError("Unexpected EOF reading local valtype")
        i += 1  # valtype (1 byte)

    normalized_bytes = bytearray()
    while i < len(raw_body):
        op = raw_body[i]
        i += 1

        # 1. Calls: blank ONLY target funcidx
        if op == 0x10:  # call
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(0x10)
            normalized_bytes.append(0x00)  # masked target index
        elif op == 0x12:  # return_call (tail call)
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(0x12)
            normalized_bytes.append(0x00)
        elif op == 0xD2:  # ref.func
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(0xD2)
            normalized_bytes.append(0x00)

        # 2. Local variables: DO NOT blank localidx
        elif op in (0x20, 0x21, 0x22):  # local.get, local.set, local.tee
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 3. Global variables and tables
        elif op in (0x23, 0x24, 0x25, 0x26):  # global.get, global.set, table.get, table.set
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 4. Control flow blocks: block (0x02), loop (0x03), if (0x04)
        elif op in (0x02, 0x03, 0x04):
            start = i
            while i < len(raw_body):
                b = raw_body[i]
                i += 1
                if (b & 0x80) == 0:
                    break
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 5. Branching
        elif op in (0x0C, 0x0D):  # br, br_if
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])
        elif op == 0x0E:  # br_table
            start = i
            count, i = _read_u32_leb128_from_bytes(raw_body, i)
            for _ in range(count):
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
            _, i = _read_u32_leb128_from_bytes(raw_body, i)  # default
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 6. Indirect calls
        elif op in (0x11, 0x13):  # call_indirect, return_call_indirect
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)  # typeidx
            _, i = _read_u32_leb128_from_bytes(raw_body, i)  # tableidx
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 7. Typed select
        elif op == 0x1C:  # select t*
            start = i
            count, i = _read_u32_leb128_from_bytes(raw_body, i)
            i += count  # count valtypes
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 8. Memory loads and stores (memarg: align u32 LEB128, offset u32 LEB128)
        elif 0x28 <= op <= 0x3E:
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)  # align
            _, i = _read_u32_leb128_from_bytes(raw_body, i)  # offset
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 9. Memory size and grow
        elif op in (0x3F, 0x40):  # memory.size, memory.grow
            start = i
            _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 10. Constants
        elif op == 0x41:  # i32.const
            raw_c, i = _read_i32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_c)
        elif op == 0x42:  # i64.const
            raw_c, i = _read_i64_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_c)
        elif op == 0x43:  # f32.const
            if i + 4 > len(raw_body):
                raise ValueError("Unexpected EOF reading f32.const")
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[i : i + 4])
            i += 4
        elif op == 0x44:  # f64.const
            if i + 8 > len(raw_body):
                raise ValueError("Unexpected EOF reading f64.const")
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[i : i + 8])
            i += 8

        # 11. Reference types
        elif op == 0xD0:  # ref.null
            if i >= len(raw_body):
                raise ValueError("Unexpected EOF reading ref.null")
            normalized_bytes.append(op)
            normalized_bytes.append(raw_body[i])
            i += 1

        # 12. Prefixed instructions: 0xFC
        elif op == 0xFC:
            start = i
            sub_op, i = _read_u32_leb128_from_bytes(raw_body, i)
            if sub_op in (8, 10, 12, 14):  # memory.init, memory.copy, table.init, table.copy
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
            elif sub_op in (9, 11, 13, 15, 16, 17):  # data.drop, memory.fill, elem.drop, table.*
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 13. Prefixed instructions: 0xFD (SIMD)
        elif op == 0xFD:
            start = i
            sub_op, i = _read_u32_leb128_from_bytes(raw_body, i)
            if sub_op in (12, 13):  # v128.const or i8x16.shuffle
                if i + 16 > len(raw_body):
                    raise ValueError("Unexpected EOF in SIMD 16-byte payload")
                i += 16
            elif sub_op <= 0x53:  # SIMD load/store with memarg
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
            elif 0x54 <= sub_op <= 0x5B:  # lane load/store
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
                _, i = _read_u32_leb128_from_bytes(raw_body, i)
                if i >= len(raw_body):
                    raise ValueError("Unexpected EOF in SIMD lane index")
                i += 1
            elif sub_op in (21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34):
                if i >= len(raw_body):
                    raise ValueError("Unexpected EOF in SIMD lane index")
                i += 1
            normalized_bytes.append(op)
            normalized_bytes.extend(raw_body[start:i])

        # 14. All other opcodes (0-operand instructions: 0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B, 0x45..0xC4, 0xD1)
        else:
            normalized_bytes.append(op)

    return hashlib.sha256(normalized_bytes).hexdigest()


# ==============================================================================
# 4. Function Matching & Diffing Engine
# ==============================================================================

@dataclass
class FunctionDiff:
    status: str  # NEW, REMOVED, GROWN, SHRUNK, UNCHANGED, CHURN, MODIFIED
    name: str
    demangled_signature: str
    base_size: int
    head_size: int
    delta: int
    percent_change: float
    is_churn: bool
    notes: str = ""


def diff_wasm_functions(
    base_funcs: List[WasmFunction],
    head_funcs: List[WasmFunction],
) -> Tuple[List[FunctionDiff], Dict[str, int]]:
    """
    Diffs base vs head functions, using multi-pass matching:
    1. Demangled symbol name match
    2. Export name match
    3. Bytecode fingerprint match (detects index/offset shifts / churn)
    4. Signature + position match for anonymous internal helpers
    """
    base_by_name: Dict[str, WasmFunction] = {}
    base_by_fp: Dict[str, List[WasmFunction]] = {}
    unmatched_base = set(range(len(base_funcs)))

    for idx, f in enumerate(base_funcs):
        # Index by demangled name
        if f.demangled_name and not f.demangled_name.startswith("func["):
            base_by_name[f.demangled_name] = f
        # Index by export name
        if f.export_name:
            base_by_name[f.export_name] = f
        # Index by fingerprint
        base_by_fp.setdefault(f.normalized_fingerprint, []).append(f)

    diffs: List[FunctionDiff] = []
    unmatched_head = []

    # Pass 1 & 2: Match head functions by name / export
    for h in head_funcs:
        matched_base = None
        # Try match by demangled name
        if h.demangled_name and h.demangled_name in base_by_name:
            matched_base = base_by_name[h.demangled_name]
        elif h.export_name and h.export_name in base_by_name:
            matched_base = base_by_name[h.export_name]

        if matched_base and matched_base.index in [base_funcs[i].index for i in unmatched_base]:
            # Found match
            base_idx = next(i for i in unmatched_base if base_funcs[i].index == matched_base.index)
            unmatched_base.remove(base_idx)

            delta = h.size - matched_base.size
            pct = ((delta / matched_base.size) * 100.0) if matched_base.size > 0 else 0.0

            if delta == 0:
                if h.raw_body == matched_base.raw_body:
                    if h.index != matched_base.index:
                        status = "CHURN"
                        is_churn = True
                        notes = "Identical logic (index shifted)"
                    else:
                        status = "UNCHANGED"
                        is_churn = False
                        notes = "Identical logic (0 B delta)"
                else:
                    status = "MODIFIED"
                    is_churn = False
                    notes = "Function modified (0 B delta)"
            elif delta > 0:
                status = "GROWN"
                is_churn = False
                notes = f"Function expanded by {delta} bytes"
            else:
                status = "SHRUNK"
                is_churn = False
                notes = f"Function shrunk by {abs(delta)} bytes"

            diffs.append(FunctionDiff(
                status=status,
                name=h.name,
                demangled_signature=h.demangled_name,
                base_size=matched_base.size,
                head_size=h.size,
                delta=delta,
                percent_change=pct,
                is_churn=is_churn,
                notes=notes,
            ))
        else:
            unmatched_head.append(h)

    # Pass 3: Match remaining head functions by normalized fingerprint (Turbopack-style churn)
    still_unmatched_head = []
    for h in unmatched_head:
        candidates = base_by_fp.get(h.normalized_fingerprint, [])
        matched_candidate = None
        for cand in candidates:
            cand_base_idx = next((i for i in unmatched_base if base_funcs[i].index == cand.index), None)
            if cand_base_idx is not None:
                matched_candidate = (cand, cand_base_idx)
                break

        if matched_candidate:
            cand, base_idx = matched_candidate
            unmatched_base.remove(base_idx)

            delta = h.size - cand.size
            pct = ((delta / cand.size) * 100.0) if cand.size > 0 else 0.0
            # Same logic/fingerprint! This is pure index/name/offset churn.
            diffs.append(FunctionDiff(
                status="CHURN",
                name=h.name,
                demangled_signature=h.demangled_name if not h.demangled_name.startswith("func[") else cand.demangled_name,
                base_size=cand.size,
                head_size=h.size,
                delta=delta,
                percent_change=pct,
                is_churn=True,
                notes="Logic identical, relocated/renumbered (filtered churn)",
            ))
        else:
            still_unmatched_head.append(h)

    # Pass 4: Truly new functions in head
    for h in still_unmatched_head:
        diffs.append(FunctionDiff(
            status="NEW",
            name=h.name,
            demangled_signature=h.demangled_name,
            base_size=0,
            head_size=h.size,
            delta=h.size,
            percent_change=100.0,
            is_churn=False,
            notes="New function added to Wasm binary",
        ))

    # Pass 5: Functions removed in head
    for base_idx in unmatched_base:
        b = base_funcs[base_idx]
        diffs.append(FunctionDiff(
            status="REMOVED",
            name=b.name,
            demangled_signature=b.demangled_name,
            base_size=b.size,
            head_size=0,
            delta=-b.size,
            percent_change=-100.0,
            is_churn=False,
            notes="Function eliminated/dead-code-stripped",
        ))

    # Compute summary stats
    counts = {
        "new": sum(1 for d in diffs if d.status == "NEW"),
        "removed": sum(1 for d in diffs if d.status == "REMOVED"),
        "grown": sum(1 for d in diffs if d.status == "GROWN"),
        "shrunk": sum(1 for d in diffs if d.status == "SHRUNK"),
        "modified": sum(1 for d in diffs if d.status == "MODIFIED"),
        "unchanged": sum(1 for d in diffs if d.status == "UNCHANGED"),
        "churn": sum(1 for d in diffs if d.status == "CHURN"),
    }

    # Sort all diffs deterministically by delta descending, then demangled name
    diffs.sort(key=lambda d: (-abs(d.delta), d.demangled_signature, d.name))

    return diffs, counts


# ==============================================================================
# 5. External Disassembler Integration (wasm-objdump / wasm-dis)
# ==============================================================================

def disassemble_wasm(wasm_path: str, output_dis_path: Optional[str] = None, preferred_tool: str = "wasm-objdump") -> str:
    """
    Disassembles a Wasm binary using wasm-objdump (preferred) or wasm-dis.
    Fails loudly with RuntimeError if no tool is available or disassembly fails.
    """
    tools = [preferred_tool]
    if preferred_tool == "wasm-objdump":
        tools.append("wasm-dis")
    else:
        tools.append("wasm-objdump")

    available_tool = next((t for t in tools if shutil.which(t)), None)
    if not available_tool:
        raise RuntimeError("No Wasm disassembler found on PATH (expected wasm-objdump or wasm-dis)")

    cmd = [available_tool, "-d", wasm_path] if available_tool == "wasm-objdump" else [available_tool, wasm_path]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Disassembly with {available_tool} failed: {e.stderr}") from e

    disassembly_text = res.stdout
    if output_dis_path:
        with open(output_dis_path, "w", encoding="utf-8") as f:
            f.write(disassembly_text)
    return disassembly_text


# ==============================================================================
# 6. CLI and Integration
# ==============================================================================

def run_wasm_diff(
    base_wasm: str,
    head_wasm: str,
    base_dis: Optional[str] = None,
    head_dis: Optional[str] = None,
    output_json: Optional[str] = None,
    output_markdown: Optional[str] = None,
    top_limit: int = 15,
) -> dict:
    """Executes full diff pipeline and optionally outputs JSON & Markdown."""
    # Ensure disassembly exists if tool available or path specified
    if base_dis and not os.path.exists(base_dis):
        disassemble_wasm(base_wasm, base_dis)
    elif not base_dis and any(shutil.which(t) for t in ("wasm-objdump", "wasm-dis")):
        dis_path = base_wasm + ".dis"
        disassemble_wasm(base_wasm, dis_path)

    if head_dis and not os.path.exists(head_dis):
        disassemble_wasm(head_wasm, head_dis)
    elif not head_dis and any(shutil.which(t) for t in ("wasm-objdump", "wasm-dis")):
        dis_path = head_wasm + ".dis"
        disassemble_wasm(head_wasm, dis_path)

    base_funcs, base_stats = parse_wasm_functions(base_wasm)
    head_funcs, head_stats = parse_wasm_functions(head_wasm)

    diffs, counts = diff_wasm_functions(base_funcs, head_funcs)

    # Sort movers by absolute byte delta descending, breaking ties deterministically by symbol name
    movers = [d for d in diffs if d.status in ("NEW", "REMOVED", "GROWN", "SHRUNK", "MODIFIED")]
    movers.sort(key=lambda d: (-abs(d.delta), d.demangled_signature, d.name))
    top_movers = movers[:top_limit]

    total_delta = head_stats["total_size"] - base_stats["total_size"]
    total_pct = ((total_delta / base_stats["total_size"]) * 100.0) if base_stats["total_size"] > 0 else 0.0

    code_delta = head_stats["code_section_size"] - base_stats["code_section_size"]
    code_pct = ((code_delta / base_stats["code_section_size"]) * 100.0) if base_stats["code_section_size"] > 0 else 0.0

    result = {
        "summary": {
            "base_total_size": base_stats["total_size"],
            "head_total_size": head_stats["total_size"],
            "total_delta": total_delta,
            "total_percent": total_pct,
            "base_code_size": base_stats["code_section_size"],
            "head_code_size": head_stats["code_section_size"],
            "code_delta": code_delta,
            "code_percent": code_pct,
            "base_functions": base_stats["total_functions"],
            "head_functions": head_stats["total_functions"],
            "counts": counts,
        },
        "top_movers": [asdict(d) for d in top_movers],
        "all_diffs": [asdict(d) for d in diffs],
    }

    if output_json:
        with open(output_json, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

    if output_markdown:
        # Import formatter and render
        from format_report import render_markdown_report
        markdown_text = render_markdown_report(result)
        with open(output_markdown, "w", encoding="utf-8") as f:
            f.write(markdown_text)

    return result


def main():
    parser = argparse.ArgumentParser(description="Wasm Function-Level Binary Diffing Tool")
    parser.add_argument("--base", required=True, help="Path to base branch .wasm binary")
    parser.add_argument("--head", required=True, help="Path to head branch .wasm binary")
    parser.add_argument("--base-dis", default=None, help="Path to base branch disassembly file")
    parser.add_argument("--head-dis", default=None, help="Path to head branch disassembly file")
    parser.add_argument("--output-json", default="wasm_diff.json", help="Path to save output JSON")
    parser.add_argument("--output-markdown", default="wasm_diff_report.md", help="Path to save markdown report")
    parser.add_argument("--top", type=int, default=15, help="Number of top movers to include in table")
    parser.add_argument("--max-delta", type=int, default=1024, help="Maximum allowable total byte growth before failing")

    args = parser.parse_args()

    # Ensure format_report can be imported from same dir
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    result = run_wasm_diff(
        base_wasm=args.base,
        head_wasm=args.head,
        base_dis=args.base_dis,
        head_dis=args.head_dis,
        output_json=args.output_json,
        output_markdown=args.output_markdown,
        top_limit=args.top,
    )

    summary = result["summary"]
    print("=" * 60)
    print("WASM FUNCTION DIFF COMPLETE")
    print(f"Base size: {summary['base_total_size']:,} B | Head size: {summary['head_total_size']:,} B")
    print(f"Delta: {summary['total_delta']:+,} B ({summary['total_percent']:+.2f}%)")
    print(f"Functions: {summary['counts']['new']} new, {summary['counts']['removed']} removed, "
          f"{summary['counts']['grown']} grown, {summary['counts']['shrunk']} shrunk, "
          f"{summary['counts']['modified']} modified (0 B), "
          f"{summary['counts']['unchanged']} unchanged, "
          f"{summary['counts']['churn']} filtered churn")
    print(f"Top movers: {len(result['top_movers'])}")
    print("=" * 60)

    if summary["total_delta"] > args.max_delta:
        print(f"ERROR: Total size growth (+{summary['total_delta']} B) exceeds maximum threshold ({args.max_delta} B)!", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
