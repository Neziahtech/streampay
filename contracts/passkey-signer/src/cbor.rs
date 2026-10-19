//! Minimal `clientDataJSON` field parser for WebAuthn assertion verification.
//!
//! `clientDataJSON` is a UTF-8 JSON object. We verify:
//! - `"type"` == `"webauthn.get"`
//! - `"challenge"` == base64url(challenge_bytes)  (RFC 4648 §5, no padding)
//!
//! No external JSON parser — only a linear byte scanner against known keys.
//! Origin binding is left to the relying-party server; see `lib.rs` security notes.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::errors::PasskeyError;

// ── base64url (RFC 4648 §5, no padding) ──────────────────────────────────────

const B64_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encodes `input` (≤32 bytes) as base64url with no padding.
/// Returns the encoded length; fills `out` starting at index 0.
/// For a 32-byte input the output is at most 43 bytes.
fn base64url_encode(input: &[u8], out: &mut [u8; 64]) -> usize {
    let mut pos = 0usize;
    let mut i = 0usize;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out[pos] = B64_CHARS[((b0 >> 2) & 0x3F) as usize];
        pos += 1;
        out[pos] = B64_CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize];
        pos += 1;
        if i + 1 < input.len() {
            out[pos] = B64_CHARS[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize];
            pos += 1;
        }
        if i + 2 < input.len() {
            out[pos] = B64_CHARS[(b2 & 0x3F) as usize];
            pos += 1;
        }
        i += 3;
    }
    pos
}

// ── JSON key–value scanner ────────────────────────────────────────────────────

/// Finds the top-level string value for `key` inside `json` bytes.
///
/// Tracks JSON object/array nesting depth and string escape sequences (`\"`, `\\`)
/// so substring matches inside string values or nested objects cannot spoof
/// `"type"` or `"challenge"`. Returns a `(start, end)` byte range into `json`
/// for the unescaped value content (excluding surrounding quotes), or `None`.
fn find_json_string_value(json: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut expecting_key = false;

    while i < json.len() {
        match json[i] {
            b' ' | b'\t' | b'\n' | b'\r' => {
                i += 1;
            }
            b'{' => {
                depth += 1;
                if depth == 1 {
                    expecting_key = true;
                }
                i += 1;
            }
            b'}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                expecting_key = false;
                i += 1;
            }
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                i += 1;
            }
            b',' => {
                if depth == 1 {
                    expecting_key = true;
                }
                i += 1;
            }
            b'"' => {
                let str_start = i + 1;
                let mut k = str_start;
                let mut has_escape = false;
                while k < json.len() {
                    if json[k] == b'\\' {
                        has_escape = true;
                        k += 2;
                        continue;
                    }
                    if json[k] == b'"' {
                        break;
                    }
                    k += 1;
                }
                if k >= json.len() {
                    return None;
                }
                let str_end = k;
                i = k + 1;

                if depth == 1 && expecting_key {
                    expecting_key = false;
                    while i < json.len() && matches!(json[i], b' ' | b'\t' | b'\n' | b'\r') {
                        i += 1;
                    }
                    if i >= json.len() || json[i] != b':' {
                        return None;
                    }
                    i += 1;
                    while i < json.len() && matches!(json[i], b' ' | b'\t' | b'\n' | b'\r') {
                        i += 1;
                    }
                    if !has_escape && &json[str_start..str_end] == key {
                        if i >= json.len() || json[i] != b'"' {
                            return None;
                        }
                        let val_start = i + 1;
                        let mut v = val_start;
                        while v < json.len() {
                            if json[v] == b'\\' {
                                return None;
                            }
                            if json[v] == b'"' {
                                return Some((val_start, v));
                            }
                            v += 1;
                        }
                        return None;
                    }
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    None
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Maximum `clientDataJSON` length accepted (2 KiB).
const MAX_CDJ_LEN: usize = 2048;

/// Verifies that `client_data_json` satisfies WebAuthn assertion requirements:
///
/// 1. `type == "webauthn.get"`
/// 2. `challenge == base64url(challenge_bytes)` (no padding)
pub fn verify_client_data_json(
    _env: &Env,
    client_data_json: &Bytes,
    challenge: &BytesN<32>,
) -> Result<(), PasskeyError> {
    let cdj_len = client_data_json.len() as usize;
    if cdj_len > MAX_CDJ_LEN {
        return Err(PasskeyError::ClientDataJsonInvalid);
    }

    // Copy Soroban Bytes into a fixed-size stack buffer.
    let mut buf = [0u8; MAX_CDJ_LEN];
    for (idx, byte) in client_data_json.iter().enumerate() {
        buf[idx] = byte;
    }
    let json = &buf[..cdj_len];

    // 1. Verify `type` field.
    let (ts, te) =
        find_json_string_value(json, b"type").ok_or(PasskeyError::ClientDataTypeMismatch)?;
    if &json[ts..te] != b"webauthn.get" {
        return Err(PasskeyError::ClientDataTypeMismatch);
    }

    // 2. Verify `challenge` field.
    let (cs, ce) =
        find_json_string_value(json, b"challenge").ok_or(PasskeyError::ChallengeMismatch)?;
    let challenge_val = &json[cs..ce];

    // Compute expected base64url.
    let challenge_arr = challenge.to_array();
    let mut b64_buf = [0u8; 64];
    let b64_len = base64url_encode(&challenge_arr, &mut b64_buf);
    let expected = &b64_buf[..b64_len];

    if challenge_val != expected {
        return Err(PasskeyError::ChallengeMismatch);
    }

    Ok(())
}
