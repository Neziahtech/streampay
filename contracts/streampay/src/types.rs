use soroban_sdk::{contracttype, Address, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefillRule {
    pub registrant: Address,
    pub amount: i128,
    pub cadence_seconds: u64,
    pub max_topups: u32,
    pub topups_executed: u32,
    pub total_budget: i128,
    pub total_refilled: i128,
    pub last_refill_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceCaps {
    pub max_per_stream_cap: i128,
    pub max_global_account_cap: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentRecord {
    pub old_rate: i128,
    pub new_rate: i128,
    pub old_end_time: u64,
    pub new_end_time: u64,
    pub effective_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    RefillRule(u64),
    GovernanceCaps,
    Agents(u64),
    AmendmentLog(u64), // stream_id -> Vec<AmendmentRecord>
    AccountBudget(Address),
    StreamSender(u64),
    StreamPaused(u64),
    StreamBalance(u64),
    StreamToken(u64),
    StreamEndTime(u64),
    StreamRate(u64),
}

pub const TTL_THRESHOLD_LEDGERS: u32 = 100_000;
pub const TTL_EXTEND_LEDGERS: u32 = 500_000;

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
    StreamExpired = 207,
    TooManyAgents = 300,
    AgentNotFound = 301,
    InvalidAgentSignature = 302,
    TooManyAmendments = 400,
    InvalidAmendmentTerms = 401,
}
