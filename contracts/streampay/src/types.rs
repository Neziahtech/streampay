use soroban::{contracttype, Address, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentRecord {
    pub old_rate: i128,
    pub new_rate: i128,
    pub old_end_time: u64,
    pub new_end_time: u64,
    pub effective_timestamp: u64,
}

/// Per-agent, per-stream cap ledger entry.
///
/// Window semantics: fixed, non-overlapping windows of `period_seconds`
/// aligned to the authorization timestamp (`window_start`). This is
/// chosen over a rolling window because it requires only a single
/// `ui64` cursor plus an `i128` counter per (agent, stream) pair, instead
/// of a history of timestamped withdrawals (which would grow unboundedly
/// and require pruning/TTL bookkeeping on every call). Fixed windows
/// also make replay across windows trivial to reason about: a signature
/// is bound to a specific cursor and cannot be reused once the cursor
/// advances.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCapState {
    /// Start of the current fixed window (Unix seconds).
    pub window_start: u64,
    /// Amount already withdrawn in the current window.
    pub withdrawn_in_window: i128,
    /// Amount already withdrawn by this agent for this stream, lifetime.
    pub withdrawn_total: i128,
    /// Last consumed signature nonce (monotonically increasing).
    pub last_nonce: u64,
}

/// Authorization record for a delegated agent on a specific stream.
///
/// Caps are enforced on-chain by the contract; the signer is only a
proxy for the recipient's authority and is never trusted to respect
/// caps itself.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAuthorization {
    /// Maximum amount which may be withdrawn per fixed window.
    pub max_per_period: i128,
    /// Length of the fixed window in seconds.
    pub period_seconds: u64,
    /// Maximum cumulative amount this agent may ever withdraw for this
    /// stream.
    pub max_total: i128,
    /// Unix timestamp after which the authorization is invalid.
    pub expires_at: u64,
    /// Timestamp at which the authorization was granted (anchors windows).
    pub authorized_at: u64,
    /// Whether the authorization has been revoked.
    pub revoked: bool,
}

/// Payload signed by the recipient to authorize an agent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizeAgentParams {
    pub recipient: Address,
    pub stream_id: u64,
    pub agent: Address,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub max_total: i128,
    pub expires_at: u64,
    pub authorized_at: u64,
}

/// Payload signed by the agent for a delegated withdrawal.
///
/// The nonce must be strictly greater than the last consumed nonce for
/// the (agent, stream) pair, which prevents replay across windows and
prevents signature reuse within a window.
/// The signature is over the XDR encoding of this structure.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegatedWithdrawParams {
    pub stream_id: u64,
    pub agent: Address,
    pub amount: i128,
    pub nonce: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    RefillRule(u64),
    GovernanceCaps,
    Agents(u64),
    AmendmentLog(u64), // stream_id -> Vec<AmendmentRecord>
    /// Authorization record for (agent, stream).
    AgentAuth(Address, u64),
    /// Cap ledger for (agent, stream).
    AgentCap(Address, u64),
    /// List of agents authorized on a stream (for revocation enumeration).
    StreamAgents(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamPayError {
    Unauthorized = 200,
    RefillRuleNotFound = 201,
    CadenceNotElapsed = 202,
    MaxTopupsExceeded = 203,
    BudgetExceeded = 204,
    StreamPaused = 205,
    GovernanceCapExceeded = 206,
    TooManyAgents = 300,
    AgentNotFound = 301,
    InvalidAgentSignature = 302,
    AgentAuthorizationExpired = 303,
    AgentRevoked = 304,
    PeriodCapExceeded = 305,
    TotalCapExceeded = 306,
    ReplayDetected = 307,
    InvalidCapParams = 308,
    TooManyAmendments = 400,
    InvalidAmendmentTerms = 401,
}
