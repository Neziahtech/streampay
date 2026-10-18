import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  checkPreconditions,
  type QueuedTransaction,
} from "../lib/pending-queue.ts";
import {
  saveCachedStreams,
  loadCachedStreams,
  saveCachedStreamDetail,
  loadCachedStreamDetail,
  purgeStaleContractStorage,
} from "../lib/offline-storage.ts";

describe("Pending Transaction Queue — Precondition & Sequence Drift Gates", () => {
  const baseTx: QueuedTransaction = {
    id: "qtx_1",
    createdAt: 1700000000000,
    address: "GD5W5P...TEST",
    network: "Test SDF Network ; September 2015",
    contractId: "C123...",
    operationType: "withdraw",
    description: "Withdraw 100 units from stream #1",
    signedXdr: "AAAA...",
    sourceSequence: "100",
    status: "pending",
  };

  it("approves a ready transaction when sequence matches (onChainSeq + 1)", () => {
    const onChainSeq = 99n; // Expected next is 100
    const res = checkPreconditions(baseTx, onChainSeq, 1000, 1700000050);
    assert.equal(res.valid, true);
    assert.equal(res.status, "ready");
    assert.equal(res.reason, undefined);
  });

  it("REFUSES submission on sequence drift (onChainSeq >= txSeq) to prevent tx_bad_seq", () => {
    // The account sequence advanced on-chain to 100 or higher
    const onChainSeq = 100n;
    const res = checkPreconditions(baseTx, onChainSeq, 1000, 1700000050);
    assert.equal(res.valid, false);
    assert.equal(res.status, "stale_sequence");
    assert.match(res.reason ?? "", /Sequence drift detected/);
    assert.match(res.reason ?? "", /tx_bad_seq/);
  });

  it("REFUSES submission on sequence drift when account has advanced far ahead", () => {
    const onChainSeq = 150n;
    const res = checkPreconditions(baseTx, onChainSeq, 1000, 1700000050);
    assert.equal(res.valid, false);
    assert.equal(res.status, "stale_sequence");
    assert.match(res.reason ?? "", /Sequence drift detected/);
  });

  it("REFUSES submission on sequence gap when account is behind", () => {
    const onChainSeq = 90n; // Missing tx 91..99
    const res = checkPreconditions(baseTx, onChainSeq, 1000, 1700000050);
    assert.equal(res.valid, false);
    assert.equal(res.status, "stale_sequence");
    assert.match(res.reason ?? "", /Sequence gap detected/);
  });

  it("REFUSES submission when timebounds maxTime has expired (tx_too_late)", () => {
    const timedTx: QueuedTransaction = {
      ...baseTx,
      sourceSequence: "100",
      maxTime: 1700000000,
    };
    const currentTimeSec = 1700000060; // 60 seconds after maxTime
    const res = checkPreconditions(timedTx, 99n, 1000, currentTimeSec);
    assert.equal(res.valid, false);
    assert.equal(res.status, "expired_timebounds");
    assert.match(res.reason ?? "", /Precondition expired: transaction timebounds expired/);
    assert.match(res.reason ?? "", /tx_too_late/);
  });

  it("REFUSES submission when timebounds minTime has not arrived (tx_too_early)", () => {
    const timedTx: QueuedTransaction = {
      ...baseTx,
      sourceSequence: "100",
      minTime: 1700000100,
    };
    const currentTimeSec = 1700000050; // 50 seconds before minTime
    const res = checkPreconditions(timedTx, 99n, 1000, currentTimeSec);
    assert.equal(res.valid, false);
    assert.equal(res.status, "expired_timebounds");
    assert.match(res.reason ?? "", /tx_too_early/);
  });

  it("REFUSES submission when ledger bounds maxLedger has passed", () => {
    const ledgerTx: QueuedTransaction = {
      ...baseTx,
      sourceSequence: "100",
      maxLedger: 500,
    };
    const currentLedger = 505;
    const res = checkPreconditions(ledgerTx, 99n, currentLedger, 1700000050);
    assert.equal(res.valid, false);
    assert.equal(res.status, "expired_ledger");
    assert.match(res.reason ?? "", /ledger #505 exceeded max ledger #500/);
  });
});

describe("Offline Storage — Stream State Caching & Invalidation", () => {
  // Mock localStorage in Node environment
  const mockStorage = new Map<string, string>();
  const originalWindow = globalThis.window;

  beforeEach(() => {
    mockStorage.clear();
    // @ts-expect-error Mocking window for Node test
    globalThis.window = {
      localStorage: {
        getItem: (k: string) => mockStorage.get(k) ?? null,
        setItem: (k: string, v: string) => {
          mockStorage.set(k, v);
        },
        removeItem: (k: string) => {
          mockStorage.delete(k);
        },
        key: (i: number) => Array.from(mockStorage.keys())[i] ?? null,
        get length() {
          return mockStorage.size;
        },
      },
    };
  });

  afterEach(() => {
    // @ts-expect-error Restoring window
    globalThis.window = originalWindow;
  });

  it("persists and rehydrates cached stream list for address", () => {
    const address = "GA123...TEST";
    const sampleStreams = [
      {
        id: "1",
        sender: address,
        recipient: "GB456...",
        token: "CDLZFC...",
        deposit: "10000000",
        withdrawn: "0",
        startTime: 1700000000,
        endTime: 1700864000,
        cancelable: true,
        status: "Active",
      },
    ];

    saveCachedStreams(address, sampleStreams);
    const loaded = loadCachedStreams(address);
    assert.notEqual(loaded, null);
    assert.equal(loaded?.address, address);
    assert.equal(loaded?.streams.length, 1);
    assert.equal(loaded?.streams[0].id, "1");
  });

  it("persists and rehydrates cached stream detail and available amount", () => {
    const streamId = "42";
    const sampleDetail = {
      id: "42",
      sender: "GA...",
      recipient: "GB...",
      token: "CDLZFC...",
      deposit: "50000000",
      withdrawn: "10000000",
      startTime: 1700000000,
      endTime: 1700864000,
      cancelable: false,
      status: "Active",
    };

    saveCachedStreamDetail(streamId, sampleDetail, 40000000n);
    const loaded = loadCachedStreamDetail(streamId);
    assert.notEqual(loaded, null);
    assert.equal(loaded?.stream.id, "42");
    assert.equal(loaded?.available, "40000000");
  });

  it("purges stale contract caches when contract ID changes", () => {
    mockStorage.set("streampay:testnet:OLD_CONTRACT:GA...:cachedStreamList", "{}");
    mockStorage.set("streampay:testnet:NEW_CONTRACT:GA...:cachedStreamList", "{}");

    purgeStaleContractStorage("NEW_CONTRACT");

    assert.equal(mockStorage.has("streampay:testnet:OLD_CONTRACT:GA...:cachedStreamList"), false);
    assert.equal(mockStorage.has("streampay:testnet:NEW_CONTRACT:GA...:cachedStreamList"), true);
  });
});

describe("PWA Artifacts & Manifest Integrity", () => {
  it("includes valid manifest.webmanifest with required PWA standalone fields", () => {
    const manifestPath = path.resolve(process.cwd(), "public", "manifest.webmanifest");
    assert.equal(existsSync(manifestPath), true, "manifest.webmanifest must exist in public/");

    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    assert.equal(manifest.name, "StreamPay — Streaming Payments on Stellar");
    assert.equal(manifest.short_name, "StreamPay");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.background_color, "#0a0e16");
    assert.equal(manifest.theme_color, "#8b7cff");
    assert(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "Must declare icons");

    // Verify icons declared in manifest exist on disk
    for (const icon of manifest.icons) {
      const iconDiskPath = path.resolve(process.cwd(), "public", icon.src.replace(/^\//, ""));
      assert.equal(existsSync(iconDiskPath), true, `Declared icon ${icon.src} must exist`);
    }
  });

  it("includes service worker sw.js implementing SWR and contract-id cache invalidation", () => {
    const swPath = path.resolve(process.cwd(), "public", "sw.js");
    assert.equal(existsSync(swPath), true, "sw.js must exist in public/");

    const swContent = readFileSync(swPath, "utf8");
    // Verify contract-id based cache names
    assert.match(swContent, /streampay-data-/);
    // Verify stale cache purging in activate
    assert.match(swContent, /caches\.delete/);
    // Verify Stale-While-Revalidate (SWR) logic
    assert.match(swContent, /cachedResponse/);
    assert.match(swContent, /fetch\(request\)/);
  });
});
