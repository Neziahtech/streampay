import { describe, expect, it } from "vitest";
import {
  createInitialTuiState,
  handleTuiKeyInput,
  renderTuiDashboard,
  TuiStreamItem,
} from "../src/tui.ts";

describe("StreamPay CLI Interactive TUI Dashboard (#606)", () => {
  const mockStreams: TuiStreamItem[] = [
    {
      id: "stream-001",
      sender: "GBSENDER...",
      recipient: "GBRECIPIENT...",
      token: "USDC",
      ratePerSecond: "1.5000000",
      accruedAmount: "450.0000000",
      depositAmount: "1000.0000000",
      status: "ACTIVE",
      exhaustionEta: "366s",
    },
    {
      id: "stream-002",
      sender: "GBSENDER...",
      recipient: "GBRECIPIENT2...",
      token: "XLM",
      ratePerSecond: "0.2500000",
      accruedAmount: "100.0000000",
      depositAmount: "500.0000000",
      status: "PAUSED",
      exhaustionEta: "1600s",
    },
  ];

  describe("TUI state initialization and navigation", () => {
    it("initializes state with selectedIndex 0 and STREAMS active panel", () => {
      const state = createInitialTuiState(mockStreams);
      expect(state.streams).toHaveLength(2);
      expect(state.selectedIndex).toBe(0);
      expect(state.activePanel).toBe("STREAMS");
    });

    it("cycles active panel on Tab", () => {
      let state = createInitialTuiState(mockStreams);
      state = handleTuiKeyInput(state, "\t").nextState;
      expect(state.activePanel).toBe("DETAILS");
      state = handleTuiKeyInput(state, "\t").nextState;
      expect(state.activePanel).toBe("EVENTS");
      state = handleTuiKeyInput(state, "\t").nextState;
      expect(state.activePanel).toBe("STREAMS");
    });

    it("updates selected stream on arrow keys", () => {
      let state = createInitialTuiState(mockStreams);
      state = handleTuiKeyInput(state, "down").nextState;
      expect(state.selectedIndex).toBe(1);
      state = handleTuiKeyInput(state, "up").nextState;
      expect(state.selectedIndex).toBe(0);
    });

    it("signals exit on 'q'", () => {
      const state = createInitialTuiState(mockStreams);
      const result = handleTuiKeyInput(state, "q");
      expect(result.exit).toBe(true);
    });
  });

  describe("action confirmation gates (withdraw & cancel)", () => {
    it("enters confirmation mode on 'w' and executes only on 'y'", () => {
      let state = createInitialTuiState(mockStreams);
      state = handleTuiKeyInput(state, "w").nextState;

      expect(state.confirmAction).not.toBeNull();
      expect(state.confirmAction?.type).toBe("WITHDRAW");
      expect(state.confirmAction?.streamId).toBe("stream-001");

      const confirmResult = handleTuiKeyInput(state, "y");
      expect(confirmResult.actionTriggered).toBe("WITHDRAW:stream-001");
      expect(confirmResult.nextState.confirmAction).toBeNull();
      expect(confirmResult.nextState.events[0].type).toBe("WITHDRAW");
    });

    it("cancels pending action on 'n'", () => {
      let state = createInitialTuiState(mockStreams);
      state = handleTuiKeyInput(state, "c").nextState;

      expect(state.confirmAction?.type).toBe("CANCEL");
      const abortResult = handleTuiKeyInput(state, "n");
      expect(abortResult.nextState.confirmAction).toBeNull();
      expect(abortResult.actionTriggered).toBeUndefined();
    });
  });

  describe("rendering & non-TTY fallback", () => {
    it("renders ASCII frame layout in TTY mode", () => {
      const state = createInitialTuiState(mockStreams);
      const rendered = renderTuiDashboard(state, true);

      expect(rendered).toContain("StreamPay Interactive Terminal Dashboard (#606)");
      expect(rendered).toContain("ACTIVE STREAMS:");
      expect(rendered).toContain("stream-001");
      expect(rendered).toContain("DETAILS: stream-001");
    });

    it("outputs valid JSON payload in non-TTY mode", () => {
      const state = createInitialTuiState(mockStreams);
      const rendered = renderTuiDashboard(state, false);

      const parsed = JSON.parse(rendered);
      expect(parsed.tui).toBe("streampay-dashboard");
      expect(parsed.streamsCount).toBe(2);
      expect(parsed.selected.id).toBe("stream-001");
    });
  });
});
