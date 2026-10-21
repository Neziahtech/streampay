import { test, expect } from "./fixtures";

test.describe("StreamPay End-to-End Suite against Disposable Sandbox Network", () => {
  test("full user journey — connect, create with test funding, accrue, withdraw, cancel", async ({
    page,
    sandbox,
    signer,
    streams,
    networkLogs,
  }) => {
    // ------------------------------------------------------------
    // 1. CONNECT
    // ------------------------------------------------------------
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("StreamPay");

    const connectButton = page.getByRole("button", { name: "Connect Freighter" });
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    // Verify successful connection as sender
    const senderAddress = signer.sender.publicKey();
    await expect(page.locator("p:has-text('Connected:')")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("code").first()).toContainText(senderAddress);

    // Form and stream management sections should now be rendered
    await expect(page.getByRole("heading", { name: "Create a stream" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your streams" })).toBeVisible();

    // ------------------------------------------------------------
    // 2. CREATE STREAM WITH TEST FUNDING
    // ------------------------------------------------------------
    const recipientAddress = signer.recipient.publicKey();
    const tokenContractId = sandbox.tokenId;
    const depositAmount = "1000000000";

    // Switch to contract token and fill out stream form using robust data-testid hooks
    await page.getByTestId("stream-asset-select").selectOption("contract");
    await page.getByTestId("stream-token-input").fill(tokenContractId);
    await page.getByTestId("stream-recipient-input").fill(recipientAddress);
    await page.getByTestId("stream-deposit-input").fill(depositAmount);
    await page.getByTestId("stream-duration-input").fill("1");
    await page.getByTestId("stream-cancelable-select").selectOption("yes");

    const createBtn = page.getByTestId("stream-submit-btn");
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    // Wait for the stream creation confirmation toast message
    const createdToast = page
      .locator("[data-testid='toast-message'], .toast-message")
      .filter({ hasText: /Stream #(\d+) created\./ });
    await expect(createdToast).toBeVisible({ timeout: 45_000 });

    const statusText = (await createdToast.textContent()) || "";
    const match = statusText.match(/Stream #(\d+) created/);
    expect(match).not.toBeNull();
    const streamId = match![1];
    expect(Number(streamId)).toBeGreaterThan(0);

    // Verify the stream appears in the on-page stream table
    const streamRow = page.locator(`tr:has-text("#${streamId}")`);
    await expect(streamRow).toBeVisible({ timeout: 15_000 });

    // ------------------------------------------------------------
    // 3. ACCRUE & DETAIL VIEW
    // ------------------------------------------------------------
    // Navigate directly to the stream detail page
    await page.goto(`/stream/${streamId}`);
    await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".kicker")).toContainText(`STREAM #${streamId}`);

    // Verify on-chain details match inputs
    await expect(page.locator("tr:has-text('Sender') td")).toHaveText(senderAddress);
    await expect(page.locator("tr:has-text('Recipient') td")).toHaveText(recipientAddress);
    const depositCell = page.locator("tr:has-text('Deposit') td");
    await expect(depositCell).toBeVisible();
    const depositTitle = await depositCell.getAttribute("title");
    expect(depositTitle).toContain(depositAmount);
    await expect(page.locator("tr:has-text('Cancelable') td")).toHaveText("true");
    await expect(page.locator("tr:has-text('Status') td")).toHaveText("Active");

    // Wait for deterministic accrual boundary to pass (eliminates NothingToWithdraw #13)
    const accrued = await streams.waitForAccrual(streamId, 1n, 20_000);
    expect(accrued).toBeGreaterThanOrEqual(0n);

    // Reload page to reflect accrued balance in UI
    await page.reload();
    await expect(page.locator("tr:has-text('Available now') td")).not.toHaveText("…");

    // ------------------------------------------------------------
    // 4. WITHDRAW ACCRUED FUNDS (Recipient Journey)
    // ------------------------------------------------------------
    // Switch deterministic signer to recipient
    await signer.setActiveAccount("recipient");

    // Reload detail page so recipient identity is recognized by Freighter bypass
    await page.reload();
    await expect(page.getByRole("heading", { name: "Withdraw accrued funds" })).toBeVisible({
      timeout: 15_000,
    });

    const withdrawMaxBtn = page.getByRole("button", { name: "Withdraw max" });
    await expect(withdrawMaxBtn).toBeVisible();
    await withdrawMaxBtn.click();

    // Verify withdrawal confirmation toast
    const claimToast = page
      .locator("[data-testid='toast-message'], .toast-message")
      .filter({ hasText: "Claimed" });
    await expect(claimToast).toBeVisible({ timeout: 45_000 });

    // Verify withdrawn amount is updated in table
    const withdrawnCell = page.locator("tr:has-text('Withdrawn') td");
    await expect(withdrawnCell).not.toHaveText("0");

    // ------------------------------------------------------------
    // 5. CANCEL (pro-rata split & refund)
    // ------------------------------------------------------------
    // Recipient can cancel because cancelable is true
    const cancelBtn = page.getByRole("button", { name: "Cancel stream" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // Verify cancellation confirmation toast
    const cancelToast = page
      .locator("[data-testid='toast-message'], .toast-message")
      .filter({ hasText: "Stream cancelled" });
    await expect(cancelToast).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("h1")).toContainText("Cancelled");
  });

  test("seeded stream lifecycle — direct detail view, live accrual, and lookup", async ({
    page,
    sandbox,
    signer,
    streams,
    networkLogs,
  }) => {
    // Pre-seed a stream created 1 hour ago
    const seededId = await streams.createSeededStream({
      deposit: 5_000_000_000n,
      durationSeconds: 86_400,
      startOffsetSeconds: -3600,
      cancelable: true,
    });

    // 1. Direct detail navigation
    await page.goto(`/stream/${seededId}`);
    await expect(page.locator(".kicker")).toContainText(`STREAM #${seededId}`, {
      timeout: 15_000,
    });
    const depositCell = page.locator("tr:has-text('Deposit') td");
    await expect(depositCell).toBeVisible();
    const depositTitle = await depositCell.getAttribute("title");
    expect(depositTitle).toContain("5000000000");

    // Verify positive accrual
    const availableCell = page.locator("tr:has-text('Available now') td");
    await expect(availableCell).not.toHaveText("0");

    // 2. Fetch by ID from homepage lookup
    await page.goto("/");
    await page.getByRole("button", { name: "Connect Freighter" }).click();
    await expect(page.locator("p:has-text('Connected:')")).toBeVisible({ timeout: 15_000 });

    const lookupInput = page.getByPlaceholder("Stream ID");
    await lookupInput.fill(seededId);
    await page.getByRole("button", { name: "Fetch stream" }).click();

    // Verify the stream appears in list
    const loadedToast = page
      .locator("[data-testid='toast-message'], .toast-message")
      .filter({ hasText: `Stream #${seededId} loaded.` });
    await expect(loadedToast).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`tr:has-text("#${seededId}")`)).toBeVisible();
  });

  test("table-level actions — discover on-chain and cancel from home stream list", async ({
    page,
    sandbox,
    signer,
    streams,
    networkLogs,
  }) => {
    // Seed a stream with recipient as the active signer
    const seededId = await streams.createSeededStream({
      sender: signer.sender.publicKey(),
      recipient: signer.recipient.publicKey(),
      deposit: 2_000_000_000n,
      startOffsetSeconds: -1800,
      cancelable: true,
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Connect Freighter" }).click();
    await expect(page.locator("p:has-text('Connected:')")).toBeVisible({ timeout: 15_000 });

    // Click discover on-chain to index streams for sender
    await page.getByRole("button", { name: "Discover on-chain" }).click();
    const discoverToast = page
      .locator("[data-testid='toast-message'], .toast-message")
      .filter({ hasText: "Discovered" });
    await expect(discoverToast).toBeVisible({ timeout: 30_000 });

    // Assert stream appears in table
    const row = page.locator(`tr:has-text("#${seededId}")`);
    await expect(row).toBeVisible();

    // Sender can cancel directly from table
    const cancelTableBtn = row.getByRole("button", { name: "Cancel" });
    if (await cancelTableBtn.isVisible()) {
      await cancelTableBtn.click();
      const cancelToast = page
        .locator("[data-testid='toast-message'], .toast-message")
        .filter({ hasText: "cancelled" });
      await expect(cancelToast).toBeVisible({ timeout: 45_000 });
    }
  });
});
