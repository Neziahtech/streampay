import type { StreamView } from "../pagination.ts";
import type { StreamHistoryEvent, StreamHistoryPage } from "../tax-lots.ts";

export const taxLotStream: StreamView = {
  id: "7",
  sender: "GSENDER",
  recipient: "GRECIPIENT",
  token: "CTOKEN",
  deposit: "1000",
  withdrawn: "500",
  startTime: 1000,
  endTime: 1100,
  cancelable: true,
  status: "Active",
  useOracle: false,
};

export const taxLotEvents: StreamHistoryEvent[] = [
  {
    seq: 1,
    event_id: "00010-1",
    name: "stream_created",
    ledger: 10,
    ledger_closed_at: "1970-01-01T00:16:40.000Z",
    tx_hash: "tx-create",
    payload: {
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "CTOKEN",
      deposit: "1000",
      start_time: "1000",
      end_time: "1100",
      cancelable: true,
    },
  },
  {
    seq: 2,
    event_id: "00020-1",
    name: "withdrawn",
    ledger: 20,
    ledger_closed_at: "1970-01-01T00:17:05.000Z",
    tx_hash: "tx-withdraw-1",
    payload: { recipient: "GRECIPIENT", amount: "150", withdrawn_total: "150" },
  },
  {
    seq: 3,
    event_id: "00030-1",
    name: "withdrawn",
    ledger: 30,
    ledger_closed_at: "1970-01-01T00:17:30.000Z",
    tx_hash: "tx-withdraw-2",
    payload: { recipient: "GRECIPIENT", amount: "350", withdrawn_total: "500" },
  },
];

export function taxLotPage(
  events: StreamHistoryEvent[],
  after: number,
  limit: number
): StreamHistoryPage {
  const page = events.filter((event) => event.seq > after).slice(0, limit);
  return {
    events: page,
    next_cursor: page.length > 0 ? page[page.length - 1].seq : null,
  };
}
