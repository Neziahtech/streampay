const STREAM_ERRORS: Record<number, string> = {
  1: "StreamNotFound",
  2: "NotStreamSender",
  3: "NotStreamRecipient",
  4: "StreamNotCancellable",
  5: "StreamNotActive",
  6: "StartTimeInPast",
  7: "InvalidTimeRange",
  8: "DurationTooLong",
  9: "ZeroAmount",
  10: "AmountExceedsAvailable",
  11: "MathOverflow",
  12: "NotAuthorized",
  13: "NothingToWithdraw",
  14: "FeeRateTooHigh",
  15: "NotGovernor",
  16: "NoPendingGovernor",
  17: "InsufficientTreasuryBalance",
};

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\(Contract, #(\d+)\)/);
  if (match) {
    const name = STREAM_ERRORS[Number(match[1])];
    return name
      ? `Contract rejected the call: ${name} (#${match[1]})`
      : `Contract error #${match[1]}`;
  }
  return message;
}