# Issue #66: Dual-Read Reconciliation Service Specification

## Overview
Implement a reliable dual-read reconciliation service that reads stream states from both Horizon (via classic-bridge effects) and Soroban RPC contract state, reconciles them, accounts for consistency lag windows, and emits structured logs and webhooks on state divergence.

## Architecture

### Core Components

1. **Horizon Reader** (`reconciler/src/readers/horizon.js`)
   - Reads stream state from Horizon API via classic-bridge effects
   - Polls Horizon for transfer/effects events related to stream tokens
   - Tracks the latest known ledger sequence for each stream
   - Returns streaming state derived from transaction effects

2. **Soroban RPC Reader** (`reconciler/src/readers/soroban.js`)
   - Reads stream state directly from Soroban RPC contract calls
   - Uses `getContractState` RPC endpoint to query stream contract storage
   - Queries multiple streams via batch calls where possible
   - Returns canonical on-chain stream state from Soroban

3. **Reconciliation Engine** (`reconciler/src/engine/diff.js`)
   - Core diff logic comparing Horizon and Soroban states
   - Configurable consistency lag window for acceptable divergence
   - Structured logging of discrepancies
   - Webhook dispatch for true divergences outside lag window

4. **Alerting Module** (`reconciler/src/alerting.js`)
   - Structured JSON logging system
   - Webhook dispatcher for indexer dashboard integration
   - Health monitoring and anomaly detection

### Data Flow
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Horizon Reader │     │ Soroban RPC     │     │ Reconciliation  │
│ (classic-bridge│     │ Reader (state)  │     │ Engine (diff)  │
│ effects)       │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Alerting Module          │
                    │ (Structured Logs +       │
                    │  Webhook Dispatch)       │
                    └────────────┬─────────────┘
                                ▼
                  ┌───────────────────────┐
                  │ Indexer Dashboard      │
                  │ (Issue #2 integration) │
                  └───────────────────────┘
```

## Requirements & Specifications

### 1. Service Architecture

#### Horizon Reader (`reconciler/src/readers/horizon.js`)
```javascript
// API
class HorizonReader {
  constructor(config: {
    url: string;                    // Horizon API endpoint
    token?: string;                 // API token for Horizon
    pollIntervalMs: number;         // Polling frequency
  });
  
  // Methods
  async pollStreams(streamIds: string[]): Promise<StreamState[]>;
  async getHistoricalData(streamId: string, fromLedger: number): Promise<StreamState[]>;
  healthCheck(): Promise<{ healthy: boolean; lastLedger?: number; }>
}

// Output
interface StreamState {
  streamId: string;
  ledger: number;
  timestamp: string;
  data: {
    deposit: string;
    withdrawn: string;
    status: 'Active' | 'Cancelled' | 'Depleted';
    // Additional fields from effects
  };
}
```

#### Soroban RPC Reader (`reconciler/src/readers/soroban.js`)
```javascript
class SorobanRpcReader {
  constructor(config: {
    url: string;                    // Soroban RPC endpoint
    token?: string;                 // API token
    pollIntervalMs: number;         // Polling frequency
    contractId: string;             // StreamPay contract ID
  });
  
  async pollStreams(streamIds: string[]): Promise<StreamState[]>;
  async getStreamState(streamId: string): Promise<StreamState>;
  healthCheck(): Promise<{ healthy: boolean; }>;
}
```

#### Reconciliation Engine (`reconciler/src/engine/diff.js`)
```javascript
class ReconciliationEngine {
  constructor(config: {
    consistencyWindowMs: number;     // Acceptable lag window (default: 30000)
    alertOnLagThreshold: number;     // Alert threshold outside window (default: 2 * window)
    logger: Logger;                   // Structured logger instance
    webhook: WebhookClient;          // Webhook dispatcher
  });
  
  async reconcile(
    horizonState: StreamState[],
    sorobanState: StreamState[],
    options?: Partial<ReconcileOptions>
  ): Promise<ReconciliationResult>;
  
  async startContinuousReconciliation(options: ContinuousOptions): Promise<void>;
}
```

### 2. Environment Variables

Required (`.env`):
```
# Horizon Configuration
HORIZON_URL=https://horizon-testnet.stellar.org

# Soroban RPC Configuration
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org/rpc

# Webhook Configuration
WEBHOOK_URL=https://indexer.streampay.local/webhooks/reconciler

# Performance & Consistency
CONSISTENCY_WINDOW_MS=30000    # 30 seconds acceptable lag
POLL_INTERVAL_MS=5000          # Poll every 5 seconds

# Optional
HORIZON_API_TOKEN=                                        # Horizon API token
SOROBAN_RPC_TOKEN=                                        # Soroban RPC token
LOG_LEVEL=info                                             # Logging level
```

### 3. Structured Logging Format

```json
{
  "timestamp": "2026-10-16T16:20:32.123Z",
  "service": "streampay-reconciler",
  "level": "ERROR|WARN|INFO|DEBUG",
  "message": "Stream 123 divergence detected",
  "details": {
    "streamId": "123",
    "checkType": "stream_balance",
    "horizonValue": {"deposit": "1000", "withdrawn": "200"},
    "sorobanValue": {"deposit": "1000", "withdrawn": "500"},
    "lagMs": 45000,
    "divergenceMs": 30000,
    "webhookSent": true,
    "webhookResponse": {"status": 200, "message": "Alert delivered"}
  }
}
```

### 4. Webhook Payload Structure

```json
{
  "alert": {
    "type": "stream_divergence",
    "severity": "critical",
    "timestamp": "2026-10-16T16:20:32.123Z",
    "source": "reconciler",
    "data": {
      "streamId": "123",
      "divergenceType": "balance_mismatch",
      "horizonState": {"deposit": "1000", "withdrawn": "200"},
      "sorobanState": {"deposit": "1000", "withdrawn": "500"},
      "lagMs": 45000,
      "consequence": "index_corruption"
    }
  },
  "metadata": {
    "version": "1.0.0",
    "environment": "testnet",
    "reconcilerId": "primary-001"
  }
}
```

## File Structure

```
reconciler/
├── docker-compose.yml              # Docker deployment manifest
├── README.md                       # Architecture and setup documentation
├── package.json                    # Node.js project configuration
├── tsconfig.json                   # TypeScript compiler config
├── .env.example                    # Environment variable template
├── src/
│   ├── index.js                    # Service entrypoint
│   ├── readers/
│   │   ├── horizon.js              # Horizon API reader
│   │   └── soroban.js              # Soroban RPC reader
│   ├── engine/
│   │   └── diff.js                 # Reconciliation engine
│   └── alerting.js                 # Logging and webhook dispatch
├── tests/
│   ├── diff.test.js                # Unit tests for reconciliation engine
│   └── soak-test.js                # Testnet soak test harness
└── .gitignore                      # Git ignore patterns
```

## Implementation Plan

### Phase 1: Foundation (Days 1-3)
1. Create `reconciler/` directory structure with all config files
2. Set up TypeScript project with test framework
3. Implement basic service skeleton and health checks
4. Create environment variable template

### Phase 2: Readers Implementation (Days 4-7)
1. Implement Horizon reader using classic-bridge effects
2. Implement Soroban RPC reader with contract state queries
3. Add polling mechanisms and error handling
4. Create data models for stream state

### Phase 3: Core Reconciliation (Days 8-10)
1. Implement diff reconciliation engine with lag window logic
2. Add structured logging framework
3. Implement webhook dispatcher
4. Create alerting conditions for divergences

### Phase 4: Testing & Deployment (Days 11-14)
1. Write comprehensive unit tests for diff engine
2. Create soak-test harness for testnet validation
3. Build docker-compose deployment manifest
4. Create complete README with setup instructions
5. Run integration tests and validation

## Testing Requirements

### Unit Tests (`reconciler/tests/diff.test.js`)
- Perfect in-sync states (expect no alerts)
- Out-of-sync within consistency lag (expect warnings/info only)
- True state divergence outside lag window (expect ERROR level and webhook)
- Missing or malformed data edge cases
- Health check endpoint validation

### Soak Test (`reconciler/tests/soak-test.js`)
- Deliberately inject stale Soroban RPC response
- Validate divergence alarm triggers
- Verify webhook payload format
- Print structured report for PR description

## Deployment Requirements

### Docker Compose (`reconciler/docker-compose.yml`)
```yaml
services:
  reconciler:
    build: .
    container_name: streampay-reconciler
    restart: unless-stopped
    environment:
      - HORIZON_URL=${HORIZON_URL:-https://horizon-testnet.stellar.org}
      - SOROBAN_RPC_URL=${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org/rpc}
      - WEBHOOK_URL=${WEBHOOK_URL:-http://indexer:8080/webhooks/reconciler}
      - CONSISTENCY_WINDOW_MS=30000
      - POLL_INTERVAL_MS=5000
    volumes:
      - ./logs:/app/logs
    depends_on:\n      - indexer
    ports:
      - "9092:8080"  # Reconciler API port
    networks:
      - streampay

  # Optional: Include indexer for webhook receiving
  indexer:
    image: streampay/indexer:latest
    container_name: streampay-indexer
    ports:
      - "8080:8080"
    networks:
      - streampay

networks:
  streampay:
    driver: bridge
```

## Monitoring & Alerting Integration

### Integration with Indexer Dashboard (Issue #2)
- Webhook endpoint targets existing indexer dashboard withdrawal panel
- Structured logs forwarded to logging infrastructure
- Prometheus metrics for monitoring (via existing infra.observability)
- Alertmanager integration for critical divergences

### Metrics Exposed
```
streampay_reconciler_divergences_total{check_type="stream_balance",severity="critical"}
stremstream_reconciler_lag_ms{stream_id="123"}
streampay_reconciler_poll_duration_seconds
streampay_reconciler_webhook_success_total
```

## Technical Constraints

1. **Latency Requirements**: Reconciliation polls should complete within poll interval
2. **Consistency**: Must tolerate network partitions and temporary inconsistencies
3. **Scalability**: Should handle multiple streams with concurrent reads
4. **Security**: All external API calls authenticated and authorized
5. **Observability**: Full structured logging and metrics export
6. **Fault Tolerance**: Graceful degradation and circuit breakers

## Acceptance Criteria

1. Dual-read reconciliation service running and polling both sources
2. Consistency lag window behavior working as configured
3. Structured logging producing correct JSON format
4. Webhook dispatch working for indexer dashboard
5. All unit tests passing
6. Soak test successfully injecting and detecting divergence
7. Docker deployment ready for production
8. Documentation complete with examples and troubleshooting

## Dependencies & Integration Points

- Integrates with existing `infra/observability/prometheus` for metrics
- Uses indexer dashboard API (Issue #2) for webhook delivery
- Compatible with existing Docker networking in `docker-compose.yml`
- Follows existing codebase TypeScript conventions and patterns
