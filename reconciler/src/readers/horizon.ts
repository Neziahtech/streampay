//! Horizon API reader that polls for effects related to StreamPay streams.

import { createHttpAgent, HttpError, type HttpAgent, type HttpResponse } from "../http.js";
import type { StreamState, StreamStatus } from "../types.js";

export interface HorizonReaderConfig {
  url: string;
  token?: string;
  pollIntervalMs: number;
  contractAccount?: string;
  httpAgent?: HttpAgent;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface HorizonHealth {
  healthy: boolean;
  lastLedger?: number;
  error?: string;
}

export class HorizonReader {
  private readonly config: HorizonReaderConfig;
  private readonly http: HttpAgent;
  private lastLedger = 0;
  private healthy = false;

  constructor(config: HorizonReaderConfig, http: HttpAgent = config.httpAgent ?? createHttpAgent()) {
    this.config = config;
    this.http = http;
  }

  /**
   * Walk a Horizon collection using cursor pagination.
   * Returns the records from every successfully fetched page.
   */
  async readRecords(endpoint: string, limit = 200): Promise<Record<string, unknown>[]> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    const retryDelayMs = this.config.retryDelayMs ?? 250;
    const records: Record<string, unknown>[] = [];
    let cursor = "0";

    while (true) {
      const response = await this.fetchWithRetry(endpoint, limit, cursor, maxAttempts, retryDelayMs);
      const page = response.data as {
        _embedded?: { records?: unknown[] };
        _links?: { next?: { href?: string } };
      };
      const pageRecords = page._embedded?.records ?? [];
      if (!Array.isArray(pageRecords) || pageRecords.length === 0) break;

      for (const record of pageRecords) {
        if (typeof record === "object" && record !== null) {
          records.push(record as Record<string, unknown>);
        }
      }

      const nextCursor = this.nextCursor(page, pageRecords);
      if (nextCursor === null || pageRecords.length < limit) break;

      // Only advance after a successful page response. A failed/retried request
      // therefore reuses this cursor instead of restarting pagination at zero.
      cursor = nextCursor;
    }

    return records;
  }

  private async fetchWithRetry(
    endpoint: string,
    limit: number,
    cursor: string,
    maxAttempts: number,
    retryDelayMs: number
  ): Promise<HttpResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = this.buildPageUrl(endpoint, limit, cursor);
        const response = await this.http.get(
          url,
          this.config.token ? { Authorization: `Bearer ${this.config.token}` } : undefined
        );

        if (this.isRetryableStatus(response.status)) {
          lastError = new HttpError(response.status, `Horizon returned HTTP ${response.status}`);
        } else if (response.status < 200 || response.status >= 300) {
          throw new HttpError(response.status, `Horizon returned HTTP ${response.status}`);
        } else {
          return response;
        }
      } catch (err: unknown) {
        lastError = err;
        if (!(err instanceof HttpError) || !this.isRetryableStatus(err.status)) {
          throw err;
        }
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new HttpError(0, "Horizon retry attempts exhausted");
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private buildPageUrl(endpoint: string, limit: number, cursor: string): string {
    const base = this.config.url.replace(/\/$/, "");
    const separator = endpoint.includes("?") ? "&" : "?";
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return `${base}${path}${separator}cursor=${encodeURIComponent(cursor)}&limit=${limit}&order=asc`;
  }

  private nextCursor(
    page: { _links?: { next?: { href?: string } } },
    pageRecords: unknown[]
  ): string | null {
    const nextHref = page._links?.next?.href;
    if (nextHref) {
      try {
        const nextUrl = new URL(nextHref, this.config.url);
        const cursor = nextUrl.searchParams.get("cursor");
        if (cursor) return cursor;
      } catch {
        // Fall through to the paging token on malformed links.
      }
    }

    const lastRecord = pageRecords[pageRecords.length - 1];
    if (typeof lastRecord === "object" && lastRecord !== null && "paging_token" in lastRecord) {
      const pagingToken = (lastRecord as { paging_token: unknown }).paging_token;
      if (typeof pagingToken === "string" && pagingToken.length > 0) return pagingToken;
    }
    return null;
  }

  async healthCheck(): Promise<HorizonHealth> {
    try {
      const response = await this.http.get(`${this.config.url}/`);
      this.healthy = response.status === 200;
      return { healthy: this.healthy, lastLedger: this.lastLedger };
    } catch (error) {
      this.healthy = false;
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Current known state for each stream id. The Horizon effect projection is
   * still a placeholder: it reports zeros rather than replaying effects, so a
   * dual read against live contract state will disagree. That is exactly why
   * the merkleized audit treats this side as a projection, not as truth.
   */
  async pollStreams(streamIds: string[]): Promise<StreamState[]> {
    if (streamIds.length === 0) return [];
    try {
      if (this.config.contractAccount) {
        await this.readRecords(`/accounts/${encodeURIComponent(this.config.contractAccount)}/effects`);
      }

      return streamIds.map((id) => ({
        streamId: id,
        ledger: this.lastLedger,
        timestamp: new Date().toISOString(),
        data: { deposit: "0", withdrawn: "0", status: "Active" satisfies StreamStatus },
      }));
    } catch (error) {
      this.healthy = false;
      console.warn(`Horizon reader error: ${String(error)}`);
      return [];
    }
  }

  /** Historical effects for one stream from a ledger onwards. */
  async getHistoricalData(_streamId: string, _fromLedger: number): Promise<StreamState[]> {
    return [];
  }

  async updateLastLedger(): Promise<number> {
    try {
      const response = await this.http.get(`${this.config.url}/ledgers?limit=1&order=desc`);
      const data = response.data as { _embedded?: { records?: Array<{ sequence?: number }> } };
      const sequence = data?._embedded?.records?.[0]?.sequence;
      if (response.status === 200 && typeof sequence === "number") {
        this.lastLedger = sequence;
        this.healthy = true;
      }
    } catch {
      this.healthy = false;
    }
    return this.lastLedger;
  }

  get latestKnownLedger(): number {
    return this.lastLedger;
  }
}

export type { StreamState, HorizonStreamEffect } from "../types.js";
