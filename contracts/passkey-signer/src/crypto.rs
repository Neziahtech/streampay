//! Cryptographic verification helpers for WebAuthn assertions.
//!
//! # P-256 on Soroban
//!
//! `env.crypto().secp256r1_verify(public_key, msg_digest, signature)` takes:
//!   - `public_key`: `BytesN<65>` — uncompressed point `0x04 || x || y`
//!   - `msg_digest`: `BytesN<32>` — SHA-256 hash of the signed payload
//!   - `signature`:  `BytesN<64>` — `r ‖ s` (big-endian, 32 bytes each)
//!
//! The function *panics* when the signature does not verify. We catch that
//! via a wrapper that makes the call in a way that lets us map it to our
//! typed error, following the same pattern as the streaming-payments contract's
//! `token_result` helper.
//!
//! WebAuthn signed payload:
//!   `message_digest = sha256(authData ‖ sha256(clientDataJSON))`

use soroban_sdk::{Bytes, BytesN, Env};

use crate::errors::PasskeyError;
use crate::registry::REGISTRATION_FLAGS_REQUIRE_UV;

/// Minimum `authenticatorData` length: 32 (rpIdHash) + 1 (flags) + 4 (signCount).
const AUTH_DATA_MIN_LEN: u32 = 37;

/// User-presence flag bit in `authData[32]`.
const UP_FLAG: u8 = 0x01;

/// User-verification flag bit in `authData[32]`.
const UV_FLAG: u8 = 0x04;

/// Backup-eligibility flag bit in `authData[32]` (WebAuthn Level 3 §6.1).
const BE_FLAG: u8 = 0x08;

/// Backup-state flag bit in `authData[32]` (WebAuthn Level 3 §6.1).
const BS_FLAG: u8 = 0x10;

/// Attested-credential-data flag bit in `authData[32]`.
const AT_FLAG: u8 = 0x40;

/// Extension-data flag bit in `authData[32]`.
const ED_FLAG: u8 = 0x80;

/// P-256 prime field modulus p = 2^256 - 2^224 + 2^192 + 2^96 - 1 (big-endian).
const P256_P: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
];

/// P-256 subgroup order n (big-endian).
const P256_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84,
    0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
];

/// Half of the P-256 subgroup order (n / 2) for canonical low-S check (big-endian).
const P256_HALF_N: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00,
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42,
    0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8,
];

fn is_zero_32(bytes: &[u8; 32]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

/// Validates that `(x, y)` are non-zero P-256 field elements strictly less than `p`.
pub fn validate_p256_coords(x: &BytesN<32>, y: &BytesN<32>) -> Result<(), PasskeyError> {
    let x_arr = x.to_array();
    let y_arr = y.to_array();
    if is_zero_32(&x_arr) || x_arr >= P256_P || is_zero_32(&y_arr) || y_arr >= P256_P {
        return Err(PasskeyError::SignatureInvalid);
    }
    Ok(())
}

/// Verifies `authenticatorData` structural requirements.
///
/// 1. Length >= 37 bytes (and == 37 bytes when neither AT nor ED flag is set).
/// 2. `authData[0..32] == rp_id_hash`.
/// 3. UP flag set.
/// 4. UV flag set if `REGISTRATION_FLAGS_REQUIRE_UV` is in `flags`.
/// 5. WebAuthn Level 3 §6.1: BS flag must not be set when BE flag is 0.
pub fn verify_auth_data(
    _env: &Env,
    auth_data: &Bytes,
    rp_id_hash: &BytesN<32>,
    flags: u32,
) -> Result<(), PasskeyError> {
    if auth_data.len() < AUTH_DATA_MIN_LEN {
        return Err(PasskeyError::AuthDataTooShort);
    }

    // Compare first 32 bytes against stored rp_id_hash.
    // We copy to a fixed array to use BytesN<32> comparison.
    let mut rp_buf = [0u8; 32];
    for (i, b) in auth_data.iter().enumerate() {
        if i == 32 {
            break;
        }
        rp_buf[i] = b;
    }
    let auth_rp: BytesN<32> = BytesN::from_array(_env, &rp_buf);
    if auth_rp != *rp_id_hash {
        return Err(PasskeyError::RpIdHashMismatch);
    }

    // Flags byte is at offset 32.
    let flag_byte = auth_data.get(32).ok_or(PasskeyError::AuthDataTooShort)?;
    if flag_byte & UP_FLAG == 0 {
        return Err(PasskeyError::UserPresenceNotSet);
    }
    if flags & REGISTRATION_FLAGS_REQUIRE_UV != 0 && flag_byte & UV_FLAG == 0 {
        return Err(PasskeyError::UserVerificationNotSet);
    }
    // WebAuthn Level 3 §6.1: Backup State (BS) cannot be 1 if Backup Eligibility (BE) is 0.
    if (flag_byte & BS_FLAG) != 0 && (flag_byte & BE_FLAG) == 0 {
        return Err(PasskeyError::SignatureInvalid);
    }
    // When neither Attested Credential Data (AT) nor Extension Data (ED) is present,
    // authenticatorData must be exactly 37 bytes.
    if (flag_byte & (AT_FLAG | ED_FLAG)) == 0 && auth_data.len() != AUTH_DATA_MIN_LEN {
        return Err(PasskeyError::SignatureInvalid);
    }

    Ok(())
}

/// Verifies the P-256 ECDSA assertion signature.
///
/// Computes `digest = sha256(authData ‖ sha256(clientDataJSON))` and calls
/// `env.crypto().secp256r1_verify`.
pub fn verify_p256_assertion(
    env: &Env,
    auth_data: &Bytes,
    client_data_json: &Bytes,
    x: &BytesN<32>,
    y: &BytesN<32>,
    sig_r: &BytesN<32>,
    sig_s: &BytesN<32>,
) -> Result<(), PasskeyError> {
    validate_p256_coords(x, y)?;

    let r_arr = sig_r.to_array();
    let s_arr = sig_s.to_array();
    if is_zero_32(&r_arr) || r_arr >= P256_N || is_zero_32(&s_arr) || s_arr > P256_HALF_N {
        return Err(PasskeyError::SignatureInvalid);
    }

    // digest = sha256(authData ‖ sha256(clientDataJSON))
    let cdj_hash = env.crypto().sha256(client_data_json);
    let mut msg = auth_data.clone();
    msg.extend_from_slice(&cdj_hash.to_array());
    let digest = env.crypto().sha256(&msg);

    // Uncompressed P-256 public key: 0x04 || x || y  (65 bytes).
    let mut pk_bytes = [0u8; 65];
    pk_bytes[0] = 0x04;
    let x_arr = x.to_array();
    let y_arr = y.to_array();
    pk_bytes[1..33].copy_from_slice(&x_arr);
    pk_bytes[33..65].copy_from_slice(&y_arr);
    let pub_key: BytesN<65> = BytesN::from_array(env, &pk_bytes);

    // Signature: r ‖ s  (64 bytes).
    let mut sig_bytes = [0u8; 64];
    sig_bytes[0..32].copy_from_slice(&r_arr);
    sig_bytes[32..64].copy_from_slice(&s_arr);
    let signature: BytesN<64> = BytesN::from_array(env, &sig_bytes);

    env.crypto().secp256r1_verify(&pub_key, &digest, &signature);

    Ok(())
}
