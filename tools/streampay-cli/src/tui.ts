/**
 * Interactive Terminal UI (TUI) Dashboard for StreamPay CLI (#606).
 *
 * Provides live-updating panels for stream inspection, real-time accrual,
 * exhaustion forecasting, and confirmed keyboard-driven actions.
 */

import { type StreamState } from "./state.ts";

export interface TuiStreamItem {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  ratePerSecond: string;
  accruedAmount: string;
  depositAmount: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  exhaustionEta: string;
}

export interface TuiEventItem {
  timestamp: string;
  streamId: string;
  type: "CREATE" | "WITHDRAW" | "PAUSE" | "RESUME" | "CANCEL";
  detail: string;
}

export type TuiActivePanel = "STREAMS" | "DETAILS" | "EVENTS" | "CONFIRM";

export interface TuiState {
  streams: TuiStreamItem[];
  selectedIndex: number;
  activePanel: TuiActivePanel;
  events: TuiEventItem[];
  confirmAction: {
    type: "WITHDRAW" | "CANCEL";
    streamId: string;
    promptText: string;
  } | null;
  statusMessage: string;
}

/**
 * Initializes a default TUI state.
 */
export function createInitialTuiState(initialStreams: TuiStreamItem[] = []): TuiState {
  return {
    streams: initialStreams,
    selectedIndex: 0,
    activePanel: "STREAMS",
    events: [
      {
        timestamp: new Date().toISOString().substring(11, 19),
        streamId: initialStreams[0]?.id || "system",
        type: "CREATE",
        detail: "Dashboard session initialized",
      },
    ],
    confirmAction: null,
    statusMessage: "Press Tab/arrows to navigate, 'w' to withdraw, 'c' to cancel, 'q' to quit",
  };
}

/**
 * Handles keyboard input events in the TUI state machine.
 */
export function handleTuiKeyInput(
  state: TuiState,
  key: string
): { nextState: TuiState; exit?: boolean; actionTriggered?: string } {
  const next = { ...state };

  if (key === "q" || key === "\u0003") {
    // Quit on 'q' or Ctrl+C
    return { nextState: next, exit: true };
  }

  // Confirmation mode
  if (next.confirmAction) {
    if (key === "y" || key === "Y") {
      const actionName = `${next.confirmAction.type}:${next.confirmAction.streamId}`;
      next.events.unshift({
        timestamp: new Date().toISOString().substring(11, 19),
        streamId: next.confirmAction.streamId,
        type: next.confirmAction.type,
        detail: `Confirmed ${next.confirmAction.type.toLowerCase()} executed`,
      });
      next.statusMessage = `Action ${next.confirmAction.type} submitted successfully!`;
      next.confirmAction = null;
      return { nextState: next, actionTriggered: actionName };
    }
    if (key === "n" || key === "N" || key === "\u001B") {
      next.statusMessage = "Action aborted by user.";
      next.confirmAction = null;
      return { nextState: next };
    }
    return { nextState: next };
  }

  // Navigation
  switch (key) {
    case "\t": // Tab
      next.activePanel =
        next.activePanel === "STREAMS"
          ? "DETAILS"
          : next.activePanel === "DETAILS"
          ? "EVENTS"
          : "STREAMS";
      break;
    case "up":
    case "k":
      if (next.selectedIndex > 0) next.selectedIndex--;
      break;
    case "down":
    case "j":
      if (next.selectedIndex < next.streams.length - 1) next.selectedIndex++;
      break;
    case "w": // Withdraw
      if (next.streams[next.selectedIndex]) {
        const stream = next.streams[next.selectedIndex];
        next.confirmAction = {
          type: "WITHDRAW",
          streamId: stream.id,
          promptText: `Are you sure you want to withdraw accrued tokens from stream ${stream.id}? [y/N]`,
        };
      }
      break;
    case "c": // Cancel
      if (next.streams[next.selectedIndex]) {
        const stream = next.streams[next.selectedIndex];
        next.confirmAction = {
          type: "CANCEL",
          streamId: stream.id,
          promptText: `Are you sure you want to CANCEL stream ${stream.id}? Unaccrued tokens will be refunded. [y/N]`,
        };
      }
      break;
  }

  return { nextState: next };
}

/**
 * Formats TUI dashboard layout into printable text frames.
 */
export function renderTuiDashboard(state: TuiState, isTty = true): string {
  if (!isTty) {
    // Graceful degradation for non-TTY: JSON-lines
    return JSON.stringify({
      tui: "streampay-dashboard",
      streamsCount: state.streams.length,
      selected: state.streams[state.selectedIndex] ?? null,
      events: state.events.slice(0, 5),
    });
  }

  const lines: string[] = [];
  lines.push("┌────────────────────────────────────────────────────────────────────────┐");
  lines.push("│ StreamPay Interactive Terminal Dashboard (#606)                        │");
  lines.push("├────────────────────────────────────────────────────────────────────────┤");

  // Streams table
  lines.push("│ ACTIVE STREAMS:                                                        │");
  if (state.streams.length === 0) {
    lines.push("│   (no streams available)                                               │");
  } else {
    state.streams.slice(0, 5).forEach((s, idx) => {
      const marker = idx === state.selectedIndex ? ">" : " ";
      const line = `│ ${marker} [${idx + 1}] ID: ${s.id.padEnd(10)} Status: ${s.status.padEnd(9)} Rate: ${s.ratePerSecond.padEnd(8)} │`;
      lines.push(line.padEnd(74, " ") + "│");
    });
  }

  lines.push("├────────────────────────────────────────────────────────────────────────┤");
  // Selected stream details
  const sel = state.streams[state.selectedIndex];
  if (sel) {
    lines.push(`│ DETAILS: ${sel.id} (${sel.status})`);
    lines.push(`│   Deposit: ${sel.depositAmount} ${sel.token} | Accrued: ${sel.accruedAmount} ${sel.token}`);
    lines.push(`│   Recipient: ${sel.recipient} | ETA: ${sel.exhaustionEta}`);
  } else {
    lines.push("│ DETAILS: No stream selected");
  }

  lines.push("├────────────────────────────────────────────────────────────────────────┤");
  // Events feed
  lines.push("│ RECENT EVENTS:                                                         │");
  state.events.slice(0, 3).forEach((ev) => {
    lines.push(`│   [${ev.timestamp}] ${ev.type.padEnd(9)} ${ev.detail.substring(0, 50)}`);
  });

  lines.push("├────────────────────────────────────────────────────────────────────────┤");
  if (state.confirmAction) {
    lines.push(`│ CONFIRMATION REQUIRED: ${state.confirmAction.promptText}`);
  } else {
    lines.push(`│ STATUS: ${state.statusMessage}`);
  }
  lines.push("└────────────────────────────────────────────────────────────────────────┘");

  return lines.join("\n");
}
