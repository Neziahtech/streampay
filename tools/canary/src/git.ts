import { execFileSync } from "node:child_process";

import type { GitCommitInfo, GitInfo } from "./types.ts";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function pullRequestFromSubject(subject: string): number | null {
  const merge = subject.match(/^Merge pull request #(\d+)/);
  if (merge) return Number(merge[1]);
  const squash = subject.match(/\(#(\d+)\)$/);
  return squash ? Number(squash[1]) : null;
}

function lastCommit(repo: string, paths: string[]): GitCommitInfo | null {
  const raw = git(repo, ["log", "-1", "--format=%H%x00%s%x00%an%x00%cI", "--", ...paths]);
  if (!raw) return null;
  const [sha, subject, author, date] = raw.split("\u0000");
  if (!sha || !subject) return null;
  return {
    sha,
    subject,
    author: author ?? "unknown",
    date: date ?? "unknown",
    pullRequest: pullRequestFromSubject(subject),
  };
}

/**
 * Captures the merge/commit that last changed the contract and the shared call
 * construction, so a scheduled failure can be tied to the PR that caused it.
 */
export function collectGitInfo(repo: string): GitInfo {
  const head = lastCommit(repo, ["."]) ?? {
    sha: "unknown",
    subject: "unknown",
    author: "unknown",
    date: "unknown",
    pullRequest: null,
  };
  return {
    sha: head.sha,
    subject: head.subject,
    author: head.author,
    date: head.date,
    pullRequest: head.pullRequest,
    contract: lastCommit(repo, ["contracts/streaming-payments"]),
    frontendOps: lastCommit(repo, ["frontend/lib/contract-ops.ts"]),
  };
}
