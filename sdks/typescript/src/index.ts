export {
  CONTRACT_ERRORS,
  CONTRACT_VERSION,
  FUNCTIONS,
  MAX_DURATION_SECONDS,
  MAX_PAGE_SIZE,
  METHODS,
  SPEC_FINGERPRINT,
  contractErrorFromMessage,
  contractErrorName,
  decodeCancelStreamResult,
  decodeCreateStreamResult,
  decodeGetStreamResult,
  decodeRecipientStreamsResult,
  decodeSenderStreamsResult,
  decodeStream,
  decodeStreamPayEvent,
  decodeTopUpResult,
  decodeWithdrawMaxResult,
  decodeWithdrawResult,
  addressToScVal,
} from "./generated.js";
export type {
  AvailableArgs,
  CancelStreamArgs,
  CreateStreamArgs,
  FunctionSpec,
  GetStreamArgs,
  Int128,
  RecipientStreamsArgs,
  SenderStreamsArgs,
  Stream,
  StreamCreatedEvent,
  StreamCancelledEvent,
  StreamStatus,
  StreamPayEvent,
  StreamToppedUpEvent,
  TopUpArgs,
  U64,
  WithdrawArgs,
  WithdrawMaxArgs,
  WithdrawnEvent,
} from "./generated.js";

export { StreamPayClient, signerFromKeypair } from "./client.js";
export type { Signer, StreamPayClientOptions } from "./client.js";
export { decodeError, StreamPayError } from "./errors.js";
export type { ContractFailure, FailureKind, StreamPayErrorOptions } from "./errors.js";
export { decodeEvent, decodeEventXdr, decodeEvents } from "./events.js";
export { collectPages } from "./pagination.js";
export type { IndexRole } from "./pagination.js";
