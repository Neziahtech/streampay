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
    Demangles Rust symbols (legacy _ZN and v0 _R mangling) and strips
    compiler-generated hash suffixes (::h[0-9a-f]{16}) so that compiler
    re-runs with identical source code match cleanly.
    """
    if not name:
        return "unnamed_function"

    # Try external c++filt / rustfilt if available
    # But implement pure Python demangler for resilience and zero-dependency CI
    demangled = name

    # Legacy Rust mangling: _ZN...E
    if name.startswith("_ZN") and name.endswith("E"):
        demangled = _demangle_rust_legacy(name)
    # Rust v0 mangling: _R...
    elif name.startswith("_R"):
        demangled = _demangle_rust_v0(name)

    # Strip any remaining 16-hex hash suffix like "::h5d438ef5cf013061" or ".h5d438ef5cf013061"
    demangled = re.sub(r'(?:::|\.)h[0-9a-fA-F]{16}\b', '', demangled)

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
        part = mangled[pos : pos + length]
        pos += length

        # Check for trailing hash: 17 chars, starting with 'h', rest hex
        if part.startswith("h") and len(part) == 17 and all(c in "0123456789abcdefABCDEF" for c in part[1:]):
            continue

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
    filtered = [p for p in parts if len(p) > 1 and not (p.startswith('h') and len(p) == 17)]
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

def compute_body_fingerprint(raw_body: bytes) -> str:
    """
    Computes a normalized SHA-256 fingerprint of the function body bytecode.
    Normalizes call instructions and variable operands so that functions
    whose bodies are identical except for relocation shifts or function
    re-indexing yield the exact same fingerprint.
    """
    # Simple linear pass over bytecode
    # Wasm bytecode: opcodes 0x10 (call) has u32 varuint operand
    # 0x02/0x03/0x04/0x0b (block/loop/if/end)
    # Mask out the specific call indices to normalize call targets
    normalized_bytes = bytearray()
    i = 0
    # Skip local declarations at start of body
    # local_count (varuint32)
    # for each: count (varuint32), valtype (1 byte)
    try:
        # Read local count
        local_groups, shift = 0, 0
        while i < len(raw_body):
            b = raw_body[i]
            i += 1
            local_groups |= (b & 0x7F) << shift
            if (b & 0x80) == 0:
                break
            shift += 7

        for _ in range(local_groups):
            # count
            while i < len(raw_body):
                b = raw_body[i]
                i += 1
                if (b & 0x80) == 0:
                    break
            # valtype (1 byte)
            if i < len(raw_body):
                i += 1
    except Exception:
        i = 0  # Fallback to entire body if malformed

    while i < len(raw_body):
        op = raw_body[i]
        normalized_bytes.append(op)
        i += 1

        # Normalize call (0x10) - mask the target index
        if op == 0x10:
            while i < len(raw_body):
                b = raw_body[i]
                i += 1
                if (b & 0x80) == 0:
                    break
            normalized_bytes.append(0x00)  # masked call target
        # Normalize local.get (0x20), local.set (0x21), local.tee (0x22)
        elif op in (0x20, 0x21, 0x22):
            while i < len(raw_body):
                b = raw_body[i]
                i += 1
                if (b & 0x80) == 0:
                    break
            normalized_bytes.append(0x01)
        # Normalize i32.const (0x41), i64.const (0x42)
        elif op in (0x41, 0x42):
            val_bytes = []
            while i < len(raw_body):
                b = raw_body[i]
                i += 1
                val_bytes.append(b)
                if (b & 0x80) == 0:
                    break
            normalized_bytes.extend(val_bytes)

    return hashlib.sha256(normalized_bytes).hexdigest()


# ==============================================================================
# 4. Function Matching & Diffing Engine
# ==============================================================================

@dataclass
class FunctionDiff:
    status: str  # NEW, REMOVED, GROWN, SHRUNK, UNCHANGED, CHURN
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
                # Same size. Did offset or index shift?
                is_churn = (h.offset != matched_base.offset or h.index != matched_base.index)
                status = "CHURN" if is_churn else "UNCHANGED"
                notes = "Identical logic (offset/index shifted)" if is_churn else "Identical"
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
        "unchanged": sum(1 for d in diffs if d.status == "UNCHANGED"),
        "churn": sum(1 for d in diffs if d.status == "CHURN"),
    }

    return diffs, counts


# ==============================================================================
# 5. External Disassembler Integration (wasm-objdump / wasm-dis)
# ==============================================================================

def disassemble_wasm(wasm_path: str, output_dis_path: Optional[str] = None, preferred_tool: str = "wasm-objdump") -> str:
    """
    Disassembles a Wasm binary using wasm-objdump (preferred) or wasm-dis.
    Justification:
    - wasm-objdump (wabt) directly annotates functions with their Code section
      byte sizes, binary offsets, and linear instructions.
    - wasm-dis (binaryen) emits WAT S-expressions, which lack binary byte boundaries.
    """
    tools = [preferred_tool]
    if preferred_tool == "wasm-objdump":
        tools.append("wasm-dis")
    else:
        tools.append("wasm-objdump")

    for tool in tools:
        if shutil.which(tool):
            try:
                cmd = [tool, "-d", wasm_path] if tool == "wasm-objdump" else [tool, wasm_path]
                res = subprocess.run(cmd, capture_output=True, text=True, check=True)
                disassembly_text = res.stdout
                if output_dis_path:
                    with open(output_dis_path, "w", encoding="utf-8") as f:
                        f.write(disassembly_text)
                return disassembly_text
            except Exception as e:
                print(f"Warning: Disassembly with {tool} failed: {e}", file=sys.stderr)

    return ""


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
    # Ensure disassembly exists if tool available
    if not base_dis or not os.path.exists(base_dis):
        dis_path = base_wasm + ".dis"
        disassemble_wasm(base_wasm, dis_path)
    if not head_dis or not os.path.exists(head_dis):
        dis_path = head_wasm + ".dis"
        disassemble_wasm(head_wasm, dis_path)

    base_funcs, base_stats = parse_wasm_functions(base_wasm)
    head_funcs, head_stats = parse_wasm_functions(head_wasm)

    diffs, counts = diff_wasm_functions(base_funcs, head_funcs)

    # Sort movers by absolute byte delta descending
    movers = [d for d in diffs if d.status in ("NEW", "REMOVED", "GROWN", "SHRUNK")]
    movers.sort(key=lambda d: abs(d.delta), reverse=True)
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
          f"{summary['counts']['churn']} filtered churn")
    print(f"Top movers: {len(result['top_movers'])}")
    print("=" * 60)


if __name__ == "__main__":
    main()
