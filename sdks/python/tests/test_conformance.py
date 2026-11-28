from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import streampay_readonly as streampay  # noqa: E402
from streampay import SPEC_FINGERPRINT, StreamPayError, decode_event_xdr  # noqa: E402
from streampay.conformance import decode_vector  # noqa: E402
from streampay_readonly import (  # noqa: E402
    ContractError,
    ReadClient,
    ScVal,
    StreamError,
    decode_contract_error,
    decode_stream_pay_event,
)
from streampay_readonly._events import canonical  # noqa: E402
from streampay_readonly._xdr import decode_invoke_contract_args  # noqa: E402

SDKS = Path(__file__).resolve().parents[2]
VECTORS = SDKS / "vectors"
SPEC = json.loads((SDKS / "spec" / "streampay.spec.json").read_text(encoding="utf-8"))


class ConformanceTest(unittest.TestCase):
    def test_vector_suite_exists(self):
        self.assertGreaterEqual(len(list(VECTORS.glob("*.json"))), 5)

    def test_every_vector_matches_recorded_expectation(self):
        for path in sorted(VECTORS.glob("*.json")):
            with self.subTest(vector=path.name):
                vector = json.loads(path.read_text())
                self.assertEqual(vector["specFingerprint"], SPEC_FINGERPRINT)
                self.assertEqual(decode_vector(vector), vector["expected"])

    def test_events_decode_to_typed_fields(self):
        vector = json.loads((VECTORS / "create-stream.json").read_text())
        event = decode_event_xdr(vector["eventsXdr"][0])
        self.assertIsNotNone(event)
        self.assertEqual(event.stream_id, 1)
        self.assertEqual(event.deposit, 10_000_000_000)
        self.assertFalse(event.cancelable)

    def test_event_decoder_rejects_a_different_contract(self):
        vector = json.loads((VECTORS / "create-stream.json").read_text())
        expected = vector["expected"]["events"][0]["contract"]
        self.assertIsNotNone(decode_event_xdr(vector["eventsXdr"][0], expected))
        self.assertIsNone(
            decode_event_xdr(
                vector["eventsXdr"][0],
                "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
            )
        )

    def test_malformed_event_is_a_decode_error(self):
        with self.assertRaises(StreamPayError) as caught:
            decode_event_xdr("not-xdr")
        self.assertEqual(caught.exception.kind.value, "decode")


class FixtureTransport:
    def __init__(self, result: str) -> None:
        self.result = result
        self.calls: list[tuple[str, tuple[bytes, ...]]] = []

    def simulate(self, method: str, args) -> str:
        self.calls.append((method, tuple(args)))
        return self.result


def load_vectors() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(VECTORS.glob("*.json"))]


def python_value(value_type, value):
    if isinstance(value_type, dict) and "option" in value_type:
        return None if value is None else python_value(value_type["option"], value)
    if isinstance(value_type, list):
        return [python_value(value_type[1], item) for item in value]
    if isinstance(value_type, str) and value_type in {"u32", "u64", "i32", "i64", "u128", "i128"}:
        return int(value)
    return value


class ReadOnlyConformanceTest(unittest.TestCase):
    def test_every_vector_matches_the_spec_fingerprint(self) -> None:
        vectors = load_vectors()
        self.assertTrue(vectors)
        for vector in vectors:
            with self.subTest(vector=vector["name"]):
                self.assertEqual(vector["specFingerprint"], streampay.SPEC_FINGERPRINT)

    def test_read_results_and_argument_bytes_match_signed_envelopes(self) -> None:
        functions = {function["name"]: function for function in SPEC["functions"] if not function["mutating"]}
        checked = 0
        for vector in load_vectors():
            expected = vector["expected"]
            function = functions.get(expected["transaction"]["function"])
            if function is None or "ok" not in expected["result"]:
                continue
            with self.subTest(vector=vector["name"]):
                args = [python_value(arg["type"], expected["transaction"]["args"][arg["name"]]) for arg in function["args"]]
                builder = getattr(streampay, f"{function['name']}_args")
                envelope = decode_invoke_contract_args(vector["transactionEnvelopeXdr"])
                self.assertEqual(envelope.contract, expected["transaction"]["contract"])
                self.assertEqual(envelope.function, function["name"])
                self.assertEqual(tuple(builder(*args)), envelope.args)

                transport = FixtureTransport(vector["resultXdr"])
                result = getattr(ReadClient(transport), function["name"])(*args)
                self.assertEqual(canonical(result), expected["result"]["ok"])
                self.assertEqual(transport.calls, [(function["name"], envelope.args)])
                checked += 1
        self.assertGreaterEqual(checked, 2)

    def test_all_error_vectors_use_the_canonical_enum(self) -> None:
        checked = 0
        for vector in load_vectors():
            expected = vector["expected"]["result"]
            if "error" not in expected:
                continue
            with self.subTest(vector=vector["name"]):
                error = decode_contract_error(vector["resultXdr"])
                self.assertIsInstance(error, StreamError)
                self.assertEqual(error.name, expected["error"]["name"])
                self.assertEqual(error.value, expected["error"]["code"])
                checked += 1
        self.assertGreater(checked, 0)

    def test_every_event_matches_canonical_json(self) -> None:
        checked = 0
        for vector in load_vectors():
            for index, encoded in enumerate(vector["eventsXdr"]):
                with self.subTest(vector=vector["name"], event=index):
                    expected = vector["expected"]["events"][index]
                    event = decode_stream_pay_event(encoded, expected["contract"])
                    self.assertIsNotNone(event)
                    self.assertEqual(event.to_dict(), expected)
                    checked += 1
        self.assertGreaterEqual(checked, 37)

    def test_argument_builders_cover_bool_option_and_empty_arguments(self) -> None:
        args = streampay.resolve_time_args(1, False)
        self.assertEqual(args[1], ScVal("bool", False).to_xdr())
        self.assertEqual(streampay.get_stream_policy_args(None), [ScVal("void", None).to_xdr()])
        self.assertEqual(streampay.total_streams_args(), [])
        with self.assertRaises(streampay.EncodeError):
            streampay.resolve_time_args(1, 1)

    def test_empty_read_result_decodes_through_the_client(self) -> None:
        transport = FixtureTransport(ScVal("u64", 0).to_xdr())
        self.assertEqual(ReadClient(transport).total_streams(), 0)

    def test_contract_error_cannot_decode_as_a_successful_stream(self) -> None:
        vector = next(vector for vector in load_vectors() if vector["name"] == "error-not-active")
        with self.assertRaises(ContractError) as caught:
            streampay.decode_get_stream_result(vector["resultXdr"])
        self.assertEqual(caught.exception.code, 5)
        self.assertEqual(caught.exception.name, "StreamNotActive")
        self.assertIs(caught.exception.error, StreamError.StreamNotActive)


if __name__ == "__main__":
    unittest.main()
