//! Horizon API reader that polls for effects related to StreamPay streams.
import { createHttpAgent } from "./http.js";
export class HorizonReader {
    config;
    http = createHttpAgent();
    lastLedger = 0;
    healthy = false;
    constructor(config) {
        this.config = config;
    }
    /**
     * Check if Horizon is healthy and reachable.
     */
    async healthCheck() {
        try {
            const response = await this.http.get(`${this.config.url}/`);
            this.healthy = response.status === 200;
            // Try to extract latest ledger from response headers or body
            return {
                healthy: this.healthy,
                lastLedger: this.lastLedger,
            };
        }
        catch (err) {
            this.healthy = false;
            return {
                healthy: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /**
     * Poll for effects that indicate stream state changes since lastLedger.
     * Returns array of StreamState objects representing current known state.
     */
    async pollStreams(streamIds) {
        try {
            // In a full implementation, we would:
            // 1. Query Horizon for effects related to stream operations
            // 2. Parse those effects to reconstruct stream state
            // 3. Return the latest known state for each streamId
            // For now, return empty array to avoid breaking the reconciliation loop
            // This is a placeholder that will be enhanced with actual Horizon integration
            // Simulate fetching effects for known streams
            if (streamIds.length === 0)
                return [];
            // TODO: Implement actual Horizon effects querying
            // Example: Query /accounts/{account}/effects?cursor=...
            return streamIds.map(id => ({
                streamId: id,
                ledger: this.lastLedger,
                timestamp: new Date().toISOString(),
                data: {
                    deposit: "0",
                    withdrawn: "0",
                    status: "Active", // Placeholder
                },
            }));
        }
        catch (err) {
            this.healthy = false;
            console.warn(`Horizon reader error: ${err}`);
            return []; // Return empty on error to allow Soroban data to dominate
        }
    }
    /**
     * Get historical effects for a specific stream from a ledger onwards.
     */
    async getHistoricalData(streamId, fromLedger) {
        // TODO: Implement historical data fetching
        return [];
    }
    /**
     * Update internal state based on latest known ledger.
     */
    async updateLastLedger() {
        try {
            const response = await this.http.get(`${this.config.url}/ledgers?limit=1&order=desc`);
            if (response.status === 200 && Array.isArray(response.data._embedded?.records)) {
                const ledger = response.data._embedded?.records[0]?.sequence;
                if (ledger && typeof ledger === "number") {
                    this.lastLedger = ledger;
                    this.healthy = true;
                }
            }
        }
        catch (err) {
            this.healthy = false;
            // Don't throw - ledger update is best-effort
        }
    }
}
