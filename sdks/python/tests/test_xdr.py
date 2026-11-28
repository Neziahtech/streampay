from __future__ import annotations

import base64
import json
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import streampay_readonly as streampay  # noqa: E402
from streampay import xdr as main_xdr  # noqa: E402
from streampay_readonly import ContractError, DecodeError, EncodeError, ScVal, decode_stream_pay_event  # noqa: E402
from streampay_readonly._generated import _encode_Stream, _encode_StreamStatus  # noqa: E402
from streampay_readonly._xdr import (  # noqa: E402
    _MAX_DEPTH,
    _Reader,
    _decode_fixed_bytes,
    _read_scval,
    _encode_address,
    _encode_i128,
    decode_invoke_contract_args,
    decode_scval,
    encode_strkey,
)

CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM"
ACCOUNT = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"
VECTORS = Path(__file__).resolve().parents[2] / "vectors"
CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4"
ACCOUNT_ID = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"


class XdrTest(unittest.TestCase):
    def roundtrip(self, value: main_xdr.ScVal) -> main_xdr.ScVal:
        reader = main_xdr.Reader(main_xdr.encode_scval(value))
        decoded = main_xdr.read_scval(reader)
        self.assertEqual(reader.offset, len(reader.data))
        return decoded

    def test_strkey_addresses_roundtrip(self):
        for address in (CONTRACT, ACCOUNT):
            decoded = self.roundtrip(main_xdr.address_to_scval(address))
            self.assertEqual(main_xdr.scval_to_address(decoded), address)

    def test_negative_i128_roundtrips(self):
        decoded = self.roundtrip(main_xdr.ScVal("i128", -(2**100)))
        self.assertEqual(main_xdr.scval_to_i128(decoded), -(2**100))

    def test_struct_maps_expose_symbol_fields(self):
        value = main_xdr.ScVal(
            "map",
            [
                (main_xdr.symbol_to_scval("id"), main_xdr.u64_to_scval(7)),
                (main_xdr.symbol_to_scval("status"), main_xdr.ScVal("u32", 2)),
            ],
        )
        fields = main_xdr.scval_to_struct(self.roundtrip(value))
        self.assertEqual(main_xdr.native(fields["id"]), 7)
        self.assertEqual(main_xdr.native(fields["status"]), 2)

    def test_unsigned_envelope_carries_the_invocation(self):
        envelope = main_xdr.build_invoke_envelope(
            source=ACCOUNT,
            contract=CONTRACT,
            function="withdraw_max",
            args=[main_xdr.u64_to_scval(3)],
            fee=100,
            sequence=42,
        )
        invocation = main_xdr.read_envelope_b64(envelope)
        self.assertEqual(invocation.contract, CONTRACT)
        self.assertEqual(invocation.function, "withdraw_max")
        self.assertEqual(invocation.source, ACCOUNT)
        self.assertEqual(invocation.fee, 100)
        self.assertEqual(invocation.sequence, 42)
        self.assertEqual(main_xdr.native(invocation.args[0]), 3)

    def test_truncated_xdr_is_rejected(self):
        encoded = main_xdr.encode_scval(main_xdr.u64_to_scval(1))
        with self.assertRaises(main_xdr.XdrError):
            main_xdr.read_scval(main_xdr.Reader(encoded[:-2]))


def active_stream_xdr() -> str:
    return json.loads((VECTORS / "get-stream-active.json").read_text(encoding="utf-8"))["resultXdr"]


def replace_stream_field(name: str, value: ScVal | None) -> str:
    stream = decode_scval(active_stream_xdr())
    entries = []
    for key, item in stream.value:
        if key.value == name:
            if value is not None:
                entries.append((key, value))
        else:
            entries.append((key, item))
    return ScVal("map", tuple(entries)).to_xdr()


def raw_contract_event_xdr(
    topics: tuple[ScVal, ...],
    data: ScVal | None = None,
    event_type: int = 1,
    contract_id: str | None = CONTRACT_ID,
) -> bytes:
    prefix = struct.pack(">ii", 0, int(contract_id is not None))
    if contract_id is not None:
        prefix += encode_strkey(contract_id)
    prefix += struct.pack(">i", event_type)
    return (
        prefix
        + struct.pack(">iI", 0, len(topics))
        + b"".join(item.to_xdr() for item in topics)
        + (data or ScVal("map", ())).to_xdr()
    )


def contract_event_xdr(topic: ScVal | None, data: ScVal | None = None, event_type: int = 1) -> bytes:
    topics = () if topic is None else (topic,)
    return raw_contract_event_xdr(topics, data, event_type)


def storage_event_xdr(name: str) -> bytes:
    root = Path(__file__).resolve().parents[3] / "test_fixtures" / "storage" / "events"
    blob = (root / f"{name}.bin").read_bytes()
    topics_length = struct.unpack("<I", blob[:4])[0]
    topics_offset = 4
    data_offset = topics_offset + topics_length
    data_length = struct.unpack("<I", blob[data_offset:data_offset + 4])[0]
    reader = _Reader(blob[topics_offset:data_offset])
    topics = tuple(_read_scval(reader) for _ in range(reader.count(4)))
    reader.expect_end()
    data = decode_scval(blob[data_offset + 4:data_offset + 4 + data_length])
    return raw_contract_event_xdr(topics, data)


def raw_map_xdr(entries: tuple[tuple[ScVal, ScVal], ...]) -> bytes:
    return (
        struct.pack(">iII", 17, 1, len(entries))
        + b"".join(key.to_xdr() + item.to_xdr() for key, item in entries)
    )


class ReadOnlyXdrTest(unittest.TestCase):
    def test_rejects_invalid_base64_truncation_and_trailing_bytes(self) -> None:
        with self.assertRaises(DecodeError):
            decode_scval("not base64!")
        raw = base64.b64decode(active_stream_xdr())
        for length in (0, 1, 3, 4, len(raw) - 1):
            with self.subTest(length=length), self.assertRaises(DecodeError):
                decode_scval(raw[:length])
        with self.assertRaises(DecodeError):
            decode_scval(raw + b"\0")

    def test_rejects_wrong_scval_kind(self) -> None:
        with self.assertRaises(DecodeError):
            streampay.decode_get_stream_result(ScVal("void", None).to_xdr())
        with self.assertRaises(DecodeError):
            streampay.decode_get_stream_result(ScVal("u64", 1).to_xdr())

    def test_rejects_nonzero_padding_and_noncanonical_map_order(self) -> None:
        padded = ScVal("bytes", b"x").to_xdr()
        with self.assertRaises(DecodeError):
            decode_scval(padded[:-1] + b"\x01")
        unordered = raw_map_xdr(
            (
                (ScVal("symbol", "z"), ScVal("u32", 1)),
                (ScVal("symbol", "a"), ScVal("u32", 2)),
            )
        )
        with self.assertRaises(DecodeError):
            decode_scval(unordered)

    def test_rejects_duplicate_and_missing_required_struct_fields(self) -> None:
        stream = decode_scval(active_stream_xdr())
        duplicate = raw_map_xdr(stream.value + ((ScVal("symbol", "id"), ScVal("u64", 1)),))
        with self.assertRaises(DecodeError):
            streampay.decode_get_stream_result(duplicate)
        with self.assertRaisesRegex(DecodeError, "Stream.id"):
            streampay.decode_get_stream_result(replace_stream_field("id", None))
        with self.assertRaisesRegex(DecodeError, "Stream.sender"):
            streampay.decode_get_stream_result(replace_stream_field("sender", None))

    def test_optional_event_fields_accept_absent_and_void_values(self) -> None:
        for value in (None, ScVal("void", None)):
            with self.subTest(value=value):
                stream = streampay.decode_get_stream_result(replace_stream_field("use_oracle", value))
                self.assertIsNone(stream.use_oracle)

        event = decode_stream_pay_event(storage_event_xdr("stream_policy_set"), CONTRACT_ID)
        self.assertIsNone(event.old_policy)
        self.assertEqual(event.new_policy.min_rate, 100)
        self.assertEqual(event.new_policy.max_duration, 31_536_000)

    def test_generated_struct_encoder_roundtrips_decoded_results(self) -> None:
        stream = streampay.decode_get_stream_result(active_stream_xdr())
        encoded = _encode_Stream(stream, "Stream").to_xdr()
        self.assertEqual(streampay.Stream.from_scval(decode_scval(encoded)), stream)

    def test_symbol_enum_encoder_uses_the_canonical_vector_form(self) -> None:
        stream = streampay.decode_get_stream_result(active_stream_xdr())
        encoded = _encode_StreamStatus(stream.status, "Stream.status").to_xdr()
        self.assertEqual(decode_scval(encoded).kind, "vec")
        self.assertEqual(stream.status.from_scval(decode_scval(encoded)), stream.status)

    def test_unknown_enum_and_contract_error_cases_are_not_successes(self) -> None:
        unknown_enum = ScVal("vec", (ScVal("symbol", "Mystery"),))
        with self.assertRaises(DecodeError):
            streampay.decode_get_stream_result(replace_stream_field("status", unknown_enum))

        unknown_error = ScVal("error", 999999).to_xdr()
        self.assertEqual(streampay.decode_contract_error(unknown_error), 999999)
        with self.assertRaises(ContractError) as caught:
            streampay.decode_get_stream_result(unknown_error)
        self.assertEqual(caught.exception.name, "UnknownContractError")
        self.assertEqual(caught.exception.error, 999999)

    def test_integer_boundaries_and_types(self) -> None:
        for value in (-(2**127), 2**127 - 1):
            encoded = _encode_i128(value, "i128").to_xdr()
            self.assertEqual(decode_scval(encoded).value, value)
        self.assertEqual(decode_scval(ScVal("u128", 2**128 - 1).to_xdr()).value, 2**128 - 1)
        for value in (-1, 2**64):
            with self.subTest(value=value), self.assertRaises(EncodeError):
                streampay.get_stream_args(value)

    def test_strkey_roundtrip_checksum_and_address_types(self) -> None:
        for address in (CONTRACT_ID, ACCOUNT_ID, CONTRACT_ID.lower()):
            encoded = _encode_address(address, "address").to_xdr()
            self.assertEqual(decode_scval(encoded).value, address.upper())
        replacement = "A" if CONTRACT_ID[-1] != "A" else "B"
        with self.assertRaises(EncodeError):
            _encode_address(CONTRACT_ID[:-1] + replacement, "address")
        with self.assertRaises(EncodeError):
            _encode_address("not-an-address", "address")

    def test_fixed_and_variable_bytes_enforce_lengths(self) -> None:
        fixed = ScVal("bytes", b"x" * 32).to_xdr()
        self.assertEqual(_decode_fixed_bytes(decode_scval(fixed), 32, "bytes32"), b"x" * 32)
        with self.assertRaises(DecodeError):
            _decode_fixed_bytes(decode_scval(ScVal("bytes", b"x").to_xdr()), 32, "bytes32")
        with self.assertRaises(DecodeError):
            streampay.GovernanceAction.from_scval(
                ScVal("vec", (ScVal("symbol", "ProposeUpgrade"), ScVal("bytes", b"x")))
            )

    def test_foreign_events_return_none_and_malformed_known_events_raise(self) -> None:
        self.assertIsNone(decode_stream_pay_event(contract_event_xdr(ScVal("symbol", "foreign")), CONTRACT_ID))
        self.assertIsNone(decode_stream_pay_event(contract_event_xdr(None, event_type=0), CONTRACT_ID))
        diagnostic = raw_contract_event_xdr((ScVal("symbol", "withdrawn"),), contract_id=None)
        self.assertIsNone(streampay.decode_contract_event(diagnostic).contract_id)
        self.assertIsNone(decode_stream_pay_event(diagnostic, CONTRACT_ID))
        self.assertIsNone(decode_stream_pay_event(contract_event_xdr(ScVal("symbol", "withdrawn")), ACCOUNT_ID))
        with self.assertRaises(DecodeError):
            decode_stream_pay_event(contract_event_xdr(ScVal("symbol", "withdrawn")), CONTRACT_ID)
        with self.assertRaisesRegex(DecodeError, "expected 2 event topics"):
            decode_stream_pay_event(
                raw_contract_event_xdr(
                    (ScVal("symbol", "withdrawn"), ScVal("u64", 1), ScVal("u64", 2))
                ),
                CONTRACT_ID,
            )

    def test_additive_event_data_fields_remain_forward_compatible(self) -> None:
        vector = json.loads((VECTORS / "withdraw.json").read_text(encoding="utf-8"))
        event = streampay.decode_contract_event(vector["eventsXdr"][0])
        data = event.data.value + ((ScVal("symbol", "future_field"), ScVal("u32", 1)),)
        encoded = raw_contract_event_xdr(
            event.topics,
            ScVal("map", tuple(sorted(data, key=lambda entry: entry[0].value))),
            contract_id=event.contract_id,
        )
        self.assertIsNotNone(decode_stream_pay_event(encoded, event.contract_id))

    def test_event_parser_rejects_trailing_bytes(self) -> None:
        encoded = contract_event_xdr(ScVal("symbol", "foreign"))
        with self.assertRaises(DecodeError):
            streampay.decode_contract_event(encoded + b"\0")
        diagnostic = contract_event_xdr(ScVal("symbol", "foreign"), event_type=0)
        with self.assertRaises(DecodeError):
            streampay.decode_contract_event(diagnostic[:-1])
        with self.assertRaises(DecodeError):
            streampay.decode_contract_event(diagnostic + b"\0")

    def test_envelope_extractor_rejects_non_invoke_transactions(self) -> None:
        with self.assertRaises(DecodeError):
            decode_invoke_contract_args("AAAAAA==")

    def test_public_scval_encoder_rejects_invalid_values_and_order(self) -> None:
        invalid = (
            ScVal("bool", 1),
            ScVal("u64", -1),
            ScVal("u256", b"x"),
            ScVal("symbol", "bad-tag"),
            ScVal("symbol", "x" * 33),
            ScVal(
                "map",
                (
                    (ScVal("symbol", "z"), ScVal("u32", 1)),
                    (ScVal("symbol", "a"), ScVal("u32", 2)),
                ),
            ),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(EncodeError):
                value.to_xdr()

    def test_symbol_decoder_enforces_soroban_limits(self) -> None:
        self.assertEqual(decode_scval(ScVal("symbol", "").to_xdr()).value, "")
        for symbol in (b"bad-tag", b"x" * 33):
            raw = struct.pack(">iI", 15, len(symbol)) + symbol + b"\0" * (-len(symbol) % 4)
            with self.subTest(symbol=symbol), self.assertRaises(DecodeError):
                decode_scval(raw)

    def test_absent_vec_and_map_are_rejected(self) -> None:
        for kind in (16, 17):
            with self.subTest(kind=kind), self.assertRaises(DecodeError):
                decode_scval(struct.pack(">iI", kind, 0))
            with self.subTest(kind=kind), self.assertRaises(EncodeError):
                ScVal("vec" if kind == 16 else "map", None).to_xdr()

    def test_untrusted_xdr_size_and_nesting_are_bounded(self) -> None:
        with patch("streampay_readonly._xdr._MAX_XDR_BYTES", 8):
            with self.assertRaisesRegex(DecodeError, "safety limit"):
                decode_scval(b"\0" * 9)
            with self.assertRaisesRegex(DecodeError, "safety limit"):
                decode_scval("A" * 16)
        nested = ScVal("u32", 0)
        raw = nested.to_xdr()
        for _ in range(_MAX_DEPTH + 1):
            nested = ScVal("vec", (nested,))
            raw = struct.pack(">iII", 16, 1, 1) + raw
        with self.assertRaisesRegex(EncodeError, "nesting"):
            nested.to_xdr()
        with self.assertRaisesRegex(DecodeError, "nesting"):
            decode_scval(raw)

    def test_envelope_extractor_accepts_all_precondition_variants(self) -> None:
        vector = json.loads((VECTORS / "get-stream-active.json").read_text(encoding="utf-8"))
        raw = base64.b64decode(vector["transactionEnvelopeXdr"])
        self.assertEqual(struct.unpack_from(">i", raw, 52)[0], 1)
        time_bounds = struct.pack(">iQQ", 1, 11, 22)
        payload = b"signed"
        v2 = (
            struct.pack(">i", 2)
            + time_bounds
            + struct.pack(">i", 0)
            + struct.pack(">iQ", 1, 7)
            + struct.pack(">QI", 3, 4)
            + struct.pack(">I", 2)
            + struct.pack(">i", 0) + b"\x01" * 32
            + struct.pack(">i", 3) + b"\x02" * 32 + struct.pack(">I", len(payload))
            + payload + b"\0" * (-len(payload) % 4)
        )
        for preconditions in (struct.pack(">i", 0), time_bounds, v2):
            with self.subTest(length=len(preconditions)):
                decoded = decode_invoke_contract_args(raw[:52] + preconditions + raw[72:])
                self.assertEqual(decoded.function, "get_stream")

    def test_envelope_extractor_rejects_trailing_bytes(self) -> None:
        vector = json.loads((VECTORS / "get-stream-active.json").read_text(encoding="utf-8"))
        raw = base64.b64decode(vector["transactionEnvelopeXdr"])
        with self.assertRaisesRegex(DecodeError, "trailing XDR data"):
            decode_invoke_contract_args(raw + b"\0")


if __name__ == "__main__":
    unittest.main()
