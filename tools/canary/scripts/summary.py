#!/usr/bin/env python3
"""Renders canary-report.json as Markdown for $GITHUB_STEP_SUMMARY."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    path = Path(argv[0]) if argv else Path("canary-report.json")
    report = json.loads(path.read_text())
    ok = report.get("status") == "success"
    icon = "✅" if ok else "🚨"

    lines = [
        f"## {icon} StreamPay testnet canary",
        "",
        f"- status: **{report.get('status')}**"
        + (" (forced failure)" if report.get("forcedFailure") else ""),
        f"- contract: `{report.get('contractId')}` on {report.get('network')}",
        f"- duration: {report.get('durationMs')} ms",
        f"- commit: `{report.get('git', {}).get('sha', 'unknown')[:12]}` "
        f"{report.get('git', {}).get('subject', '')}",
    ]

    contract_commit = report.get("git", {}).get("contract")
    if contract_commit:
        pr = contract_commit.get("pullRequest")
        lines.append(
            f"- contract last changed by: `{contract_commit.get('sha', '')[:12]}` "
            f"{contract_commit.get('subject', '')}"
            + (f" (PR #{pr})" if pr else "")
        )

    stream = report.get("stream")
    if stream:
        lines.append(f"- stream: `#{stream['id']}`")

    lines += ["", "### Steps", "", "| step | status | duration | tx |", "|---|---|---|---|"]
    for step in report.get("steps", []):
        tx = step.get("txHash") or ""
        lines.append(
            f"| {step.get('name')} | {step.get('status')} | "
            f"{step.get('durationMs')} ms | `{tx}` |"
        )

    failure = report.get("failure")
    if failure:
        lines += [
            "",
            f"### Failure — {failure.get('step')} ({failure.get('failureClass')})",
            "",
            f"{failure.get('message')}",
            "",
        ]
        if failure.get("rpcMethod") or failure.get("rpcExcerpt"):
            lines.append(f"**RPC ({failure.get('rpcMethod', 'unknown')})**: "
                         f"`{failure.get('rpcExcerpt', '')}`")
        if failure.get("transactionXdr"):
            lines += ["", "**Transaction XDR**", "", "```", failure["transactionXdr"], "```"]
        if failure.get("resultXdr"):
            lines += ["", "**Result XDR**", "", "```", failure["resultXdr"], "```"]
        lines += ["", f"**Hint**: {failure.get('hint', '')}"]

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
