//! Soroban RPC reader: reads contract state for streams.

import { createHttpAgent, type HttpAgent } from "../http.js";
import type { StreamState, StreamStatus } from "../types.js";
import { statusString, toAuditRecord, type AuditRecord } from "../audit/canonical.js";
import type { StateSource } from "../audit/auditor.js";

export interface SorobanRpcReaderConfig {
  url: string;
  token?: string;
  pollIntervalMs: number;
  contractId: string;
  httpAgent?: HttpAgent;
}

/** One decoded field of a stored stream. */
export interface StreamFields {
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  start_time: string;
  end_time: string;
  cancelable: boolean;
  status: string;
}

/**
 * Turns the RPC's returned value for one storage field into a plain string.
 * The default is deliberately strict: an undecodable value must fail loudly
 * rather than be hashed as a placeholder and reported as a divergence.
 */
export type ValueDecoder = (key: string, xdr: string) => string;

const FIELDS: Array<keyof StreamFields> = [
  "sender",
  "recipient",
  "token",
  "deposit",
  "withdrawn",
  "start_time",
  "end_time",
  "cancelable",
  "status",
];

export class SorobanRpcReader {
  private readonly config: SorobanRpcReaderConfig;
  private readonly http: HttpAgent;
  private healthy = false;

  constructor(config: SorobanRpcReaderConfig, http: HttpAgent = config.httpAgent ?? createHttpAgent()) {
    this.config = config;
    this.http = http;
  }

  get contractId(): string {
    return this.config.contractId;
  }

  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await this.http.get(this.config.url);
      this.healthy = response.status === 200;
      return { healthy: this.healthy };
    } catch (error) {
      this.healthy = false;
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async pollStreams(streamIds: string[]): Promise<StreamState[]> {
    if (streamIds.length === 0) return [];
    try {
      const states = await Promise.all(streamIds.map((id) => this.getStreamState(id)));
      return states.filter((state): state is StreamState => state !== null);
    } catch (error) {
      this.healthy = false;
      console.warn(`Soroban RPC reader error: ${String(error)}`);
      return [];
    }
  }

  /**
   * Reads the audited field set for every stream and returns the on-chain
   * side of an audit cycle. A stream whose stored fields cannot be decoded is
   * reported rather than dropped, because silently omitting it would move the
   * root without an explanation anyone could verify.
   */
  async read(
    streamIds: string[],
    decode: ValueDecoder,
    ledger: number
  ): Promise<StateSource> {
    const records: AuditRecord[] = [];
    const failures: string[] = [];

    for (const streamId of streamIds) {
      try {
        const raw: Record<string, string> = {};
        for (const field of FIELDS) {
          const key = `stream:${streamId}:${field}`;
          const xdr = await this.readContractData(key);
          if (xdr === null) throw new Error(`storage field '${key}' is absent`);
          raw[field] = decode(key, xdr);
        }
        records.push(
          toAuditRecord({
            streamId,
            sender: raw.sender,
            recipient: raw.recipient,
            token: raw.token,
            deposit: raw.deposit,
            withdrawn: raw.withdrawn,
            startTime: raw.start_time,
            endTime: raw.end_time,
            cancelable: raw.cancelable === "true",
            status: statusString(raw.status),
          })
        );
      } catch (error) {
        failures.push(
          `${streamId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`soroban read failed for ${failures.length} stream(s): ${failures.join("; ")}`);
    }
    return { ledger, records };
  }

  async getStreamState(streamId: string): Promise<StreamState | null> {
    const keys = ["deposit", "withdrawn", "start_time", "end_time", "cancelable", "status"];
    const results = await Promise.allSettled(
      keys.map((field) => this.readContractData(`stream:${streamId}:${field}`))
    );
    const valueAt = (index: number): string | null => {
      const result = results[index];
      return result?.status === "fulfilled" ? result.value : null;
    };

    const deposit = valueAt(0);
    const withdrawn = valueAt(1);
    if (deposit === null || withdrawn === null) return null;

    const statusRaw = valueAt(5);
    const status: StreamStatus =
      statusRaw !== null && ["Active", "Cancelled", "Depleted", "Paused"].includes(statusRaw)
        ? (statusRaw as StreamStatus)
        : "Active";

    return {
      streamId,
      ledger: await this.getLatestLedger().catch(() => 0),
      timestamp: new Date().toISOString(),
      data: { deposit, withdrawn, status },
    };
  }

  /** Reads one contract data entry, returning null when it is absent. */
  private async readContractData(key: string): Promise<string | null> {
    const response = await this.http.post(`${this.config.url}/rpc/getContractData`, {
      contractId: this.config.contractId,
      key: Buffer.from(key).toString("hex"),
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Soroban RPC error: ${response.status}`);
    const data = response.data as { xdr?: string } | null;
    return data?.xdr ?? null;
  }

  async getLatestLedger(): Promise<number> {
    const response = await this.http.get(this.config.url);
    const data = response.data as { ledger?: number } | null;
    if (response.status !== 200 || data === null || typeof data.ledger !== "number") {
      throw new Error("soroban RPC did not report a ledger sequence");
    }
    return data.ledger;
  }
}

export type { StreamState, SorobanStreamStorage } from "../types.js";
