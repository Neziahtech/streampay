import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatWebAuthnError,
  loadRegisteredDevices,
  saveRegisteredDevices,
  listRegisteredCredentials,
  revokeDeviceCredential,
  PasskeyDeviceCredential,
} from "./passkey";
import * as passkeyModule from "./passkey";

describe("Passkey Recovery & Multi-Device Credential Management (#603)", () => {
  const ownerAddress = "GBTESTOWNER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABC";
  const storageMap = new Map<string, string>();

  beforeEach(() => {
    storageMap.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, val: string) => storageMap.set(key, val),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("WebAuthn error handling", () => {
    it("maps user cancellation (NotAllowedError) to clear message", () => {
      const err = new Error("The operation was canceled");
      err.name = "NotAllowedError";
      expect(formatWebAuthnError(err)).toBe("Passkey operation was cancelled or timed out.");
    });

    it("maps platform unsupported error (NotSupportedError) gracefully", () => {
      const err = new Error("Not supported");
      err.name = "NotSupportedError";
      expect(formatWebAuthnError(err)).toBe(
        "Passkeys are not supported on this browser or platform."
      );
    });

    it("handles generic errors cleanly", () => {
      expect(formatWebAuthnError(new Error("RPC timeout"))).toBe("RPC timeout");
      expect(formatWebAuthnError("random error")).toBe(
        "An unexpected passkey error occurred."
      );
    });
  });

  describe("multi-device credential listing and lifecycle", () => {
    const dev1: PasskeyDeviceCredential = {
      id: "cred-1",
      deviceLabel: "MacBook Pro TouchID",
      createdAt: 1700000000000,
      lastUsedAt: 1700000000000,
      signCount: 15,
      rpIdHash: "hash1",
      status: "active",
      publicKeyX: "01".repeat(32),
      publicKeyY: "02".repeat(32),
    };

    const dev2: PasskeyDeviceCredential = {
      id: "cred-2",
      deviceLabel: "YubiKey 5C NFC",
      createdAt: 1700000010000,
      lastUsedAt: 1700000010000,
      signCount: 3,
      rpIdHash: "hash1",
      status: "active",
      publicKeyX: "03".repeat(32),
      publicKeyY: "04".repeat(32),
    };

    it("lists stored credentials correctly", async () => {
      vi.spyOn(passkeyModule, "isPasskeyRegistered").mockResolvedValue(true);
      saveRegisteredDevices(ownerAddress, [dev1, dev2]);

      const list = await listRegisteredCredentials(ownerAddress);
      expect(list).toHaveLength(2);
      expect(list[0].deviceLabel).toBe("MacBook Pro TouchID");
      expect(list[1].deviceLabel).toBe("YubiKey 5C NFC");
    });

    it("revokes a secondary device without deregistering on-chain", async () => {
      vi.spyOn(passkeyModule, "isPasskeyRegistered").mockResolvedValue(true);
      saveRegisteredDevices(ownerAddress, [dev1, dev2]);

      const result = await revokeDeviceCredential(ownerAddress, "cred-2");
      expect(result.success).toBe(true);
      expect(result.remainingCount).toBe(1);

      const updated = loadRegisteredDevices(ownerAddress);
      expect(updated.find((d) => d.id === "cred-2")?.status).toBe("revoked");
      expect(updated.find((d) => d.id === "cred-1")?.status).toBe("active");
    });
  });
});
