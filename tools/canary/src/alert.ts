/**
 * Failure alerts: a self-contained payload plus GitHub annotations and an
 * optional chat webhook. The payload names the exact step, distinguishes
 * simulation from submission/inclusion failures, and includes the RPC excerpt
 * and XDR so the failure is actionable without shell access to the runner.
 */
import { excerpt } from "./errors.ts";
import type { CanaryReport } from "./report.ts";
import type { RunContext, StreamRef } from "./types.ts";

export interface AlertPayload {
  schema: "streampay-canary-alert/v1";
  status: "failure";
  title: string;
  step: {
    name: string;
    index: number;
    failureClass: string;
    message: string;
    hint: string;
  };
  rpc: {
    method: string | null;
    excerpt: string | null;
  };
  xdr: {
    transactionEnvelope: string | null;
    result: string | null;
  };
  stream: StreamRef | null;
  contract: string;
  network: string;
  run: RunContext;
  git: CanaryReport["git"];
  forced: boolean;
  text: string;
}

export function buildAlert(report: CanaryReport): AlertPayload | null {
  const failure = report.failure;
  if (failure === null) return null;

  const stepIndex = report.steps.findIndex((step) => step.name === failure.step);
  const alert: AlertPayload = {
    schema: "streampay-canary-alert/v1",
    status: "failure",
    title: `StreamPay testnet canary failed at ${failure.step} (${failure.failureClass})`,
    step: {
      name: failure.step,
      index: stepIndex,
      failureClass: failure.failureClass,
      message: failure.message,
      hint: failure.hint,
    },
    rpc: {
      method: failure.rpcMethod ?? null,
      excerpt: failure.rpcExcerpt ?? null,
    },
    xdr: {
      transactionEnvelope: failure.transactionXdr ?? null,
      result: failure.resultXdr ?? null,
    },
    stream: report.stream,
    contract: report.contractId,
    network: report.network,
    run: report.run,
    git: report.git,
    forced: failure.forced === true,
    text: "",
  };
  alert.text = alertText(alert);
  return alert;
}

export function alertText(alert: AlertPayload): string {
  const lines = [
    `🚨 ${alert.title}${alert.forced ? " [FORCED]" : ""}`,
    "",
    `step     : ${alert.step.name} (${alert.step.failureClass})`,
    `contract : ${alert.contract} (${alert.network})`,
    `run      : ${alert.run.runUrl}`,
    `commit   : ${alert.git.sha.slice(0, 12)} ${alert.git.subject}`,
  ];
  if (alert.git.contract !== null) {
    lines.push(
      `contract last changed by: ${alert.git.contract.sha.slice(0, 12)} ${alert.git.contract.subject}` +
        (alert.git.contract.pullRequest === null
          ? ""
          : ` (PR #${alert.git.contract.pullRequest})`)
    );
  }
  if (alert.stream !== null) {
    lines.push(`stream   : #${alert.stream.id}`);
  }
  lines.push("", `error    : ${alert.step.message}`);
  if (alert.rpc.method !== null || alert.rpc.excerpt !== null) {
    lines.push(`rpc      : ${alert.rpc.method ?? "unknown"} — ${alert.rpc.excerpt ?? ""}`);
  }
  if (alert.xdr.transactionEnvelope !== null) {
    lines.push(`tx XDR   : ${alert.xdr.transactionEnvelope}`);
  }
  if (alert.xdr.result !== null) {
    lines.push(`res XDR  : ${alert.xdr.result}`);
  }
  lines.push("", `hint     : ${alert.step.hint}`);
  return lines.join("\n");
}

export interface EmitAlertOptions {
  webhook?: string;
  githubActions?: boolean;
  fetchImpl?: typeof fetch;
}

/** Emits the alert without ever failing the run because an alert channel did. */
export async function emitAlert(
  alert: AlertPayload,
  options: EmitAlertOptions = {}
): Promise<void> {
  console.error(alert.text);

  const githubActions =
    options.githubActions ?? process.env.GITHUB_ACTIONS === "true";
  if (githubActions) {
    console.log(
      `::error title=${escapeAnnotation(alert.title)}::${escapeAnnotation(
        alert.step.message
      )}`
    );
    for (const line of alert.text.split("\n")) {
      if (line.trim() !== "") console.log(line);
    }
  }

  const webhook = options.webhook ?? process.env.CANARY_ALERT_WEBHOOK;
  if (webhook === undefined || webhook === "") return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const isSlack = webhook.includes("hooks.slack.com");
  const body = isSlack
    ? { text: `\`\`\`\n${alert.text}\n\`\`\`` }
    : alert;

  try {
    const response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`alert webhook returned HTTP ${response.status}: ${excerpt(await response.text(), 300)}`);
    }
  } catch (error) {
    console.warn(`alert webhook failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function escapeAnnotation(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/,/g, "%2C");
}
