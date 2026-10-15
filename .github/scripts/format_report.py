#!/usr/bin/env python3
"""
Report Formatter for WebAssembly (Wasm) Function-Level Binary Diffing.
Generates a GitHub PR comment markdown table.
"""

import argparse
import json
import os
import sys
from typing import Any, Dict


def format_bytes(b: int) -> str:
    """Format bytes with +/- sign and thousands separators."""
    if b > 0:
        return f"+{b:,} B"
    elif b < 0:
        return f"-{abs(b):,} B"
    return "0 B"


def format_size(b: int) -> str:
    """Format positive size in bytes."""
    return f"{b:,} B"


def render_markdown_report(diff_data: Dict[str, Any]) -> str:
    """
    Renders a comprehensive, GitHub-formatted PR comment markdown document
    from the diff JSON result.
    """
    summary = diff_data.get("summary", {})
    top_movers = diff_data.get("top_movers", [])
    counts = summary.get("counts", {})

    total_delta = summary.get("total_delta", 0)
    total_pct = summary.get("total_percent", 0.0)
    code_delta = summary.get("code_delta", 0)
    code_pct = summary.get("code_percent", 0.0)

    # Determine status icon
    if total_delta > 1024:
        header_icon = "⚠️"
        trend_badge = "🔴 **Size Increased**"
    elif total_delta < -1024:
        header_icon = "🎉"
        trend_badge = "🟢 **Size Decreased**"
    elif total_delta == 0:
        header_icon = "✨"
        trend_badge = "⚪ **Neutral / Net Zero**"
    else:
        header_icon = "ℹ️"
        trend_badge = "🟡 **Minor Shift**"

    lines = [
        "<!-- wasm-diff-report -->",
        f"### {header_icon} WebAssembly Binary Function-Level Diff",
        "",
        f"**Net Wasm Size Change**: {trend_badge} (`{format_bytes(total_delta)}` / `{total_pct:+.2f}%`)",
        "",
        "#### 📊 High-Level Metrics",
        "",
        "| Metric | Base Branch | Head (PR) | Delta | Change |",
        "| :--- | :--- | :--- | :--- | :--- |",
        f"| **Total Binary Size** | `{format_size(summary.get('base_total_size', 0))}` | `{format_size(summary.get('head_total_size', 0))}` | `{format_bytes(total_delta)}` | `{total_pct:+.2f}%` |",
        f"| **Code Section Size** | `{format_size(summary.get('base_code_size', 0))}` | `{format_size(summary.get('head_code_size', 0))}` | `{format_bytes(code_delta)}` | `{code_pct:+.2f}%` |",
        f"| **Function Count** | `{summary.get('base_functions', 0)}` | `{summary.get('head_functions', 0)}` | `{summary.get('head_functions', 0) - summary.get('base_functions', 0):+d}` | - |",
        "",
        f"**Breakdown**: {counts.get('new', 0)} new &bull; {counts.get('removed', 0)} removed &bull; "
        f"{counts.get('grown', 0)} grown &bull; {counts.get('shrunk', 0)} shrunk &bull; "
        f"**{counts.get('churn', 0)} filtered offset/symbol churn** (0 B net growth)",
        "",
    ]

    # Top movers table
    lines.append("#### ⚡ Top Movers by Bytes")
    lines.append("")

    if not top_movers:
        lines.append("> _No significant function size changes detected._")
        lines.append("")
    else:
        lines.append("| Status | Function Signature (Demangled) | Base Size | Head Size | Byte Delta | % Change |")
        lines.append("| :---: | :--- | :---: | :---: | :---: | :---: |")

        for m in top_movers:
            status = m.get("status", "")
            if status == "NEW":
                status_badge = "🟢 `NEW`"
                base_str = "-"
                head_str = format_size(m.get("head_size", 0))
                delta_str = f"**+{m.get('delta', 0):,} B**"
                pct_str = "NEW"
            elif status == "REMOVED":
                status_badge = "🔴 `REMOVED`"
                base_str = format_size(m.get("base_size", 0))
                head_str = "-"
                delta_str = f"**-{abs(m.get('delta', 0)):,} B**"
                pct_str = "-100%"
            elif status == "GROWN":
                status_badge = "📈 `GROWN`"
                base_str = format_size(m.get("base_size", 0))
                head_str = format_size(m.get("head_size", 0))
                delta_str = f"+{m.get('delta', 0):,} B"
                pct_str = f"`+{m.get('percent_change', 0.0):.1f}%`"
            elif status == "SHRUNK":
                status_badge = "📉 `SHRUNK`"
                base_str = format_size(m.get("base_size", 0))
                head_str = format_size(m.get("head_size", 0))
                delta_str = f"-{abs(m.get('delta', 0)):,} B"
                pct_str = f"`{m.get('percent_change', 0.0):.1f}%`"
            else:
                status_badge = f"`{status}`"
                base_str = format_size(m.get("base_size", 0))
                head_str = format_size(m.get("head_size", 0))
                delta_str = format_bytes(m.get("delta", 0))
                pct_str = f"`{m.get('percent_change', 0.0):.1f}%`"

            sig = m.get("demangled_signature", m.get("name", "unknown"))
            # Escape pipes for markdown table
            sig_escaped = sig.replace("|", "\\|")
            # Truncate overly long signatures for clean table rendering
            if len(sig_escaped) > 85:
                sig_display = f"`{sig_escaped[:82]}...`"
            else:
                sig_display = f"`{sig_escaped}`"

            lines.append(f"| {status_badge} | {sig_display} | {base_str} | {head_str} | {delta_str} | {pct_str} |")

        lines.append("")

    # Normalization & Churn Explanation
    lines.extend([
        "<details>",
        "<summary><b>ℹ️ Normalization & Churn Filtering Details</b></summary>",
        "",
        "Turbopack-style offset churn occurs when upstream code edits shift the binary offset, function index, "
        "or mangled symbol hash (e.g. `_ZN...h<16hex>`) of downstream functions without altering their actual logic. "
        "This tool normalizes the disassembled instruction stream and symbol names to distinguish between:",
        "- **Turbopack-style churn**: Same functions with shifted offsets/relocations (0 net byte growth). Filtered out of Top Movers to eliminate review fatigue.",
        "- **Real changes**: True function byte expansion/reduction (`GROWN` / `SHRUNK`) and genuine additions/deletions (`NEW` / `REMOVED`).",
        "",
        "**Disassembly Tool Choice**:",
        "- Disassembly engine: `wasm-objdump` (WebAssembly Binary Toolkit - `wabt`) / Direct Wasm Code section analyzer.",
        "- *Justification*: `wasm-objdump` reads exact binary Code section boundaries and byte lengths (`size=N`) directly from the Wasm binary. "
        "Unlike `wasm-dis` (which outputs S-expression WAT text without function byte sizes or offsets), `wasm-objdump` gives "
        "exact byte-level granularity required for accurate function diffing.",
        "</details>",
        "",
        "---",
        "_Report generated by `.github/workflows/wasm-diff.yml` &bull; StreamPay CI_",
    ])

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Format Wasm Diff JSON into Markdown Report")
    parser.add_argument("--input", default="wasm_diff.json", help="Input JSON file from wasm_diff.py")
    parser.add_argument("--output", default="wasm_diff_report.md", help="Output Markdown report path")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    markdown = render_markdown_report(data)

    with open(args.output, "w", encoding="utf-8") as f:
        f.write(markdown)

    print(f"Report written to {args.output}")


if __name__ == "__main__":
    main()
