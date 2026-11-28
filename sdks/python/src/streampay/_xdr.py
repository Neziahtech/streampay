from __future__ import annotations

import base64
import binascii
import struct
from dataclasses import dataclass
from typing import Any, Callable

from ._errors import DecodeError, EncodeError


_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_MAX_DEPTH = 128
_MAX_XDR_BYTES = 16 * 1024 * 1024
_SYMBOL_BYTES = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


def _validate_symbol(value: str) -> None:
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ValueError("symbol must contain only ASCII letters, digits, and underscores") from error
    if len(encoded) > 32 or any(byte not in _SYMBOL_BYTES for byte in encoded):
        raise ValueError("symbol must be 0-32 ASCII letters, digits, or underscores")


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    @property
    def remaining(self) -> int:
        return len(self.data) - self.offset

    def read(self, length: int) -> bytes:
        if length < 0 or length > self.remaining:
            raise DecodeError(f"truncated XDR at offset {self.offset}: need {length} bytes")
        start = self.offset
        self.offset += length
        return self.data[start:self.offset]

    def u32(self) -> int:
        return struct.unpack(">I", self.read(4))[0]

    def i32(self) -> int:
        return struct.unpack(">i", self.read(4))[0]

    def u64(self) -> int:
        return struct.unpack(">Q", self.read(8))[0]

    def i64(self) -> int:
        return struct.unpack(">q", self.read(8))[0]

    def u128(self) -> int:
        return int.from_bytes(self.read(16), "big")

    def i128(self) -> int:
        return int.from_bytes(self.read(16), "big", signed=True)

    def boolean(self) -> bool:
        value = self.u32()
        if value not in (0, 1):
            raise DecodeError(f"invalid XDR boolean {value}")
        return bool(value)

    def variable_bytes(self) -> bytes:
        length = self.u32()
        padded = (length + 3) & ~3
        if padded > self.remaining:
            raise DecodeError(f"truncated XDR string of length {length}")
        value = self.read(length)
        padding = self.read(padded - length)
        if any(padding):
            raise DecodeError("nonzero XDR padding")
        return value

    def string(self) -> str:
        try:
            return self.variable_bytes().decode("utf-8")
        except UnicodeDecodeError as error:
            raise DecodeError("XDR string is not valid UTF-8") from error

    def count(self, minimum_item_size: int) -> int:
        count = self.u32()
        if count > self.remaining // minimum_item_size:
            raise DecodeError(f"XDR count {count} exceeds remaining payload")
        return count

    def expect_end(self) -> None:
        if self.remaining:
            raise DecodeError(f"trailing XDR data at offset {self.offset}")


@dataclass(frozen=True)
class ScVal:
    kind: str
    value: Any

    def to_xdr(self) -> bytes:
        return _write_scval(self)


_SCVAL_ORDER = {
    "bool": 0,
    "void": 1,
    "error": 2,
    "u32": 3,
    "i32": 4,
    "u64": 5,
    "i64": 6,
    "timepoint": 7,
    "duration": 8,
    "u128": 9,
    "i128": 10,
    "u256": 11,
    "i256": 12,
    "bytes": 13,
    "string": 14,
    "symbol": 15,
    "vec": 16,
    "map": 17,
    "address": 18,
}


def _scval_sort_key(value: ScVal, depth: int = 0) -> tuple[Any, ...]:
    if depth > _MAX_DEPTH:
        raise EncodeError("ScVal nesting exceeds the safety limit")
    try:
        order = _SCVAL_ORDER[value.kind]
    except KeyError as error:
        raise EncodeError(f"cannot order ScVal kind {value.kind}") from error
    if value.kind in ("bool", "error", "u32", "i32", "u64", "i64", "timepoint", "duration", "u128", "i128", "i256"):
        return order, value.value
    if value.kind == "void":
        return order, 0
    if value.kind in ("u256", "bytes"):
        return order, value.value
    if value.kind in ("string", "symbol"):
        return order, value.value.encode("utf-8")
    if value.kind == "vec":
        return order, 1, tuple(_scval_sort_key(item, depth + 1) for item in value.value)
    if value.kind == "map":
        return order, 1, tuple(
            (_scval_sort_key(key, depth + 1), _scval_sort_key(item, depth + 1))
            for key, item in value.value
        )
    return order, _write_scval(value, depth + 1)


@dataclass(frozen=True)
class ContractEvent:
    contract_id: str | None
    event_type: int
    topics: tuple[ScVal, ...] | None
    data: ScVal | None


@dataclass(frozen=True)
class InvokeContractArgs:
    contract: str
    function: str
    args: tuple[bytes, ...]


def _crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode_strkey(value: str) -> bytes:
    if not isinstance(value, str):
        raise EncodeError("address must be a string")
    alphabet_value = value.upper()
    if not alphabet_value or any(character not in _BASE32 for character in alphabet_value):
        raise EncodeError(f"invalid StrKey address: {value}")
    try:
        decoded = base64.b32decode(alphabet_value + "=" * ((-len(alphabet_value)) % 8))
    except (binascii.Error, ValueError) as error:
        raise EncodeError(f"invalid StrKey address: {value}") from error
    if len(decoded) != 35:
        raise EncodeError(f"invalid StrKey address length: {value}")
    payload, checksum = decoded[:-2], decoded[-2:]
    if int.from_bytes(checksum, "little") != _crc16(payload):
        raise EncodeError(f"invalid StrKey checksum: {value}")
    version = payload[0]
    if version == 48:
        return payload[1:]
    if version == 16:
        return payload[1:]
    raise EncodeError(f"unsupported StrKey address type: {value}")


def decode_strkey(version: int, payload: bytes) -> str:
    if len(payload) != 32 or version not in (48, 16):
        raise DecodeError("unsupported StrKey address")
    body = bytes([version]) + payload
    checksum = _crc16(body).to_bytes(2, "little")
    return base64.b32encode(body + checksum).decode("ascii").rstrip("=")


def _read_address(reader: _Reader) -> str:
    address_type = reader.i32()
    if address_type == 0:
        if reader.i32() != 0:
            raise DecodeError("unsupported account public key type")
        return decode_strkey(48, reader.read(32))
    if address_type == 1:
        return decode_strkey(16, reader.read(32))
    raise DecodeError(f"unsupported ScAddress type {address_type}")


def _read_scval(reader: _Reader, depth: int = 0) -> ScVal:
    if depth > _MAX_DEPTH:
        raise DecodeError("ScVal nesting exceeds the safety limit")
    kind = reader.i32()
    if kind == 0:
        return ScVal("bool", reader.boolean())
    if kind == 1:
        return ScVal("void", None)
    if kind == 2:
        if reader.i32() != 0:
            raise DecodeError("unsupported ScError type")
        return ScVal("error", reader.u32())
    if kind == 3:
        return ScVal("u32", reader.u32())
    if kind == 4:
        return ScVal("i32", reader.i32())
    if kind == 5:
        return ScVal("u64", reader.u64())
    if kind == 6:
        return ScVal("i64", reader.i64())
    if kind == 7:
        return ScVal("timepoint", reader.u64())
    if kind == 8:
        return ScVal("duration", reader.u64())
    if kind == 9:
        return ScVal("u128", reader.u128())
    if kind == 10:
        return ScVal("i128", reader.i128())
    if kind == 11:
        return ScVal("u256", reader.read(32))
    if kind == 12:
        return ScVal("i256", int.from_bytes(reader.read(32), "big", signed=True))
    if kind == 13:
        return ScVal("bytes", reader.variable_bytes())
    if kind == 14:
        return ScVal("string", reader.string())
    if kind == 15:
        symbol = reader.string()
        try:
            _validate_symbol(symbol)
        except ValueError as error:
            raise DecodeError(f"invalid XDR symbol: {error}") from error
        return ScVal("symbol", symbol)
    if kind == 16:
        if reader.boolean() is False:
            raise DecodeError("ScVal vec must be present")
        count = reader.count(4)
        return ScVal("vec", tuple(_read_scval(reader, depth + 1) for _ in range(count)))
    if kind == 17:
        if reader.boolean() is False:
            raise DecodeError("ScVal map must be present")
        count = reader.count(8)
        entries = []
        previous_key: tuple[Any, ...] | None = None
        for _ in range(count):
            key = _read_scval(reader, depth + 1)
            key_order = _scval_sort_key(key)
            if previous_key is not None and key_order <= previous_key:
                raise DecodeError("XDR map keys are duplicate or out of order")
            previous_key = key_order
            value = _read_scval(reader, depth + 1)
            entries.append((key, value))
        return ScVal("map", tuple(entries))
    if kind == 18:
        return ScVal("address", _read_address(reader))
    raise DecodeError(f"unsupported ScVal type {kind}")


def _raw_xdr(encoded: bytes | str) -> bytes:
    if isinstance(encoded, str):
        if len(encoded) > ((_MAX_XDR_BYTES + 2) // 3) * 4:
            raise DecodeError("base64 XDR exceeds the safety limit")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise DecodeError("invalid base64 XDR") from error
    elif isinstance(encoded, bytes):
        raw = encoded
    else:
        raise DecodeError("XDR must be base64 text or raw bytes")
    if len(raw) > _MAX_XDR_BYTES:
        raise DecodeError("XDR exceeds the safety limit")
    return raw


def decode_scval(encoded: bytes | str) -> ScVal:
    reader = _Reader(_raw_xdr(encoded))
    value = _read_scval(reader)
    reader.expect_end()
    return value


def _integer(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EncodeError(f"{label}: expected an integer")
    if not minimum <= value <= maximum:
        raise EncodeError(f"{label}: integer out of range")
    return value


def _u32_bytes(value: int) -> bytes:
    return struct.pack(">I", value)


def _i32_bytes(value: int) -> bytes:
    return struct.pack(">i", value)


def _u64_bytes(value: int) -> bytes:
    return struct.pack(">Q", value)


def _i64_bytes(value: int) -> bytes:
    return struct.pack(">q", value)


def _i128_bytes(value: int) -> bytes:
    return value.to_bytes(16, "big", signed=True)


def _u128_bytes(value: int) -> bytes:
    return value.to_bytes(16, "big")


def _variable_bytes(value: bytes) -> bytes:
    return _u32_bytes(len(value)) + value + b"\0" * ((-len(value)) % 4)


def _write_scval(value: ScVal, depth: int = 0) -> bytes:
    if depth > _MAX_DEPTH:
        raise EncodeError("ScVal nesting exceeds the safety limit")
    if not isinstance(value, ScVal):
        raise EncodeError("expected a ScVal")
    kind = value.kind
    if kind == "bool":
        if not isinstance(value.value, bool):
            raise EncodeError("bool ScVal requires a bool")
        return _i32_bytes(0) + _u32_bytes(int(value.value))
    if kind == "void":
        if value.value is not None:
            raise EncodeError("void ScVal requires None")
        return _i32_bytes(1)
    if kind == "error":
        return _i32_bytes(2) + _i32_bytes(0) + _u32_bytes(_integer(value.value, 0, 2**32 - 1, "error"))
    if kind == "u32":
        return _i32_bytes(3) + _u32_bytes(_integer(value.value, 0, 2**32 - 1, "u32"))
    if kind == "i32":
        return _i32_bytes(4) + _i32_bytes(_integer(value.value, -(2**31), 2**31 - 1, "i32"))
    if kind == "u64":
        return _i32_bytes(5) + _u64_bytes(_integer(value.value, 0, 2**64 - 1, "u64"))
    if kind == "i64":
        return _i32_bytes(6) + _i64_bytes(_integer(value.value, -(2**63), 2**63 - 1, "i64"))
    if kind == "timepoint":
        return _i32_bytes(7) + _u64_bytes(_integer(value.value, 0, 2**64 - 1, "timepoint"))
    if kind == "duration":
        return _i32_bytes(8) + _u64_bytes(_integer(value.value, 0, 2**64 - 1, "duration"))
    if kind == "u128":
        return _i32_bytes(9) + _u128_bytes(_integer(value.value, 0, 2**128 - 1, "u128"))
    if kind == "i128":
        return _i32_bytes(10) + _i128_bytes(_integer(value.value, -(2**127), 2**127 - 1, "i128"))
    if kind == "u256":
        if not isinstance(value.value, bytes) or len(value.value) != 32:
            raise EncodeError("u256 ScVal requires 32 bytes")
        return _i32_bytes(11) + value.value
    if kind == "i256":
        integer = _integer(value.value, -(2**255), 2**255 - 1, "i256")
        return _i32_bytes(12) + integer.to_bytes(32, "big", signed=True)
    if kind == "bytes":
        if not isinstance(value.value, bytes):
            raise EncodeError("bytes ScVal requires bytes")
        return _i32_bytes(13) + _variable_bytes(value.value)
    if kind == "string":
        if not isinstance(value.value, str):
            raise EncodeError("string ScVal requires a string")
        return _i32_bytes(14) + _variable_bytes(value.value.encode("utf-8"))
    if kind == "symbol":
        if not isinstance(value.value, str):
            raise EncodeError("symbol ScVal requires a string")
        try:
            _validate_symbol(value.value)
        except ValueError as error:
            raise EncodeError(str(error)) from error
        return _i32_bytes(15) + _variable_bytes(value.value.encode("ascii"))
    if kind == "vec":
        if not isinstance(value.value, (list, tuple)) or not all(isinstance(item, ScVal) for item in value.value):
            raise EncodeError("vec ScVal requires a present sequence of ScVal values")
        items = b"".join(_write_scval(item, depth + 1) for item in value.value)
        return _i32_bytes(16) + _u32_bytes(1) + _u32_bytes(len(value.value)) + items
    if kind == "map":
        if not isinstance(value.value, (list, tuple)):
            raise EncodeError("map ScVal requires a sequence of entries")
        encoded_entries = []
        previous_key: tuple[Any, ...] | None = None
        for entry in value.value:
            if not isinstance(entry, (list, tuple)) or len(entry) != 2:
                raise EncodeError("map ScVal entries must be key/value pairs")
            key, item = entry
            if not isinstance(key, ScVal) or not isinstance(item, ScVal):
                raise EncodeError("map ScVal keys and values must be ScVal values")
            try:
                key_order = _scval_sort_key(key)
            except (AttributeError, TypeError, ValueError) as error:
                raise EncodeError("map ScVal key is invalid") from error
            if previous_key is not None and key_order <= previous_key:
                raise EncodeError("map ScVal keys are duplicate or out of order")
            previous_key = key_order
            encoded_entries.append(
                _write_scval(key, depth + 1) + _write_scval(item, depth + 1)
            )
        entries = b"".join(encoded_entries)
        return _i32_bytes(17) + _u32_bytes(1) + _u32_bytes(len(value.value)) + entries
    if kind == "address":
        if not isinstance(value.value, str):
            raise EncodeError("address ScVal requires a string")
        payload = encode_strkey(value.value)
        if value.value.upper().startswith("C"):
            return _i32_bytes(18) + _i32_bytes(1) + payload
        return _i32_bytes(18) + _i32_bytes(0) + _i32_bytes(0) + payload
    raise EncodeError(f"cannot encode ScVal kind {kind}")


def _encode_bool(value: Any, context: str) -> ScVal:
    if not isinstance(value, bool):
        raise EncodeError(f"{context}: expected a bool")
    return ScVal("bool", value)


def _encode_u32(value: Any, context: str) -> ScVal:
    return ScVal("u32", _integer(value, 0, 2**32 - 1, context))


def _encode_i32(value: Any, context: str) -> ScVal:
    return ScVal("i32", _integer(value, -(2**31), 2**31 - 1, context))


def _encode_u64(value: Any, context: str) -> ScVal:
    return ScVal("u64", _integer(value, 0, 2**64 - 1, context))


def _encode_i64(value: Any, context: str) -> ScVal:
    return ScVal("i64", _integer(value, -(2**63), 2**63 - 1, context))


def _encode_timepoint(value: Any, context: str) -> ScVal:
    return ScVal("timepoint", _integer(value, 0, 2**64 - 1, context))


def _encode_duration(value: Any, context: str) -> ScVal:
    return ScVal("duration", _integer(value, 0, 2**64 - 1, context))


def _encode_i128(value: Any, context: str) -> ScVal:
    return ScVal("i128", _integer(value, -(2**127), 2**127 - 1, context))


def _encode_u128(value: Any, context: str) -> ScVal:
    return ScVal("u128", _integer(value, 0, 2**128 - 1, context))


def _encode_i256(value: Any, context: str) -> ScVal:
    return ScVal("i256", _integer(value, -(2**255), 2**255 - 1, context))


def _encode_u256(value: Any, context: str) -> ScVal:
    if not isinstance(value, bytes) or len(value) != 32:
        raise EncodeError(f"{context}: expected 32 bytes")
    return ScVal("u256", value)


def _encode_address(value: Any, context: str) -> ScVal:
    try:
        encode_strkey(value)
    except EncodeError as error:
        raise EncodeError(f"{context}: {error}") from error
    return ScVal("address", value)


def _encode_string(value: Any, context: str) -> ScVal:
    if not isinstance(value, str):
        raise EncodeError(f"{context}: expected a string")
    return ScVal("string", value)


def _encode_symbol(value: Any, context: str) -> ScVal:
    if not isinstance(value, str):
        raise EncodeError(f"{context}: expected a symbol")
    try:
        _validate_symbol(value)
    except ValueError as error:
        raise EncodeError(f"{context}: {error}") from error
    return ScVal("symbol", value)


def _encode_fixed_bytes(value: Any, length: int, context: str) -> ScVal:
    if not isinstance(value, bytes) or len(value) != length:
        raise EncodeError(f"{context}: expected {length} bytes")
    return ScVal("bytes", value)


def _encode_bytes(value: Any, length: int, context: str) -> ScVal:
    if length >= 0:
        return _encode_fixed_bytes(value, length, context)
    if not isinstance(value, bytes):
        raise EncodeError(f"{context}: expected bytes")
    return ScVal("bytes", value)


def _encode_option(value: Any, encode: Callable[[Any], ScVal], context: str) -> ScVal:
    return ScVal("void", None) if value is None else encode(value)


def _encode_vec(value: Any, encode: Callable[[Any], ScVal], context: str) -> ScVal:
    if not isinstance(value, (list, tuple)):
        raise EncodeError(f"{context}: expected a sequence")
    return ScVal("vec", tuple(encode(item) for item in value))


def _expect(value: ScVal, kind: str, context: str) -> Any:
    if value.kind != kind:
        raise DecodeError(f"{context}: expected {kind}, got {value.kind}")
    return value.value


def _decode_bool(value: ScVal, context: str) -> bool:
    return _expect(value, "bool", context)


def _decode_void(value: ScVal, context: str) -> None:
    _expect(value, "void", context)
    return None


def _decode_u32(value: ScVal, context: str) -> int:
    return _expect(value, "u32", context)


def _decode_i32(value: ScVal, context: str) -> int:
    return _expect(value, "i32", context)


def _decode_u64(value: ScVal, context: str) -> int:
    if value.kind == "u32":
        return value.value
    return _expect(value, "u64", context)


def _decode_i64(value: ScVal, context: str) -> int:
    return _expect(value, "i64", context)


def _decode_timepoint(value: ScVal, context: str) -> int:
    return _expect(value, "timepoint", context)


def _decode_duration(value: ScVal, context: str) -> int:
    return _expect(value, "duration", context)


def _decode_i128(value: ScVal, context: str) -> int:
    if value.kind in ("u32", "u64"):
        return value.value
    return _expect(value, "i128", context)


def _decode_u128(value: ScVal, context: str) -> int:
    if value.kind in ("u32", "u64"):
        return value.value
    return _expect(value, "u128", context)


def _decode_i256(value: ScVal, context: str) -> int:
    return _expect(value, "i256", context)


def _decode_u256(value: ScVal, length: int, context: str) -> bytes:
    result = _expect(value, "u256", context)
    if len(result) != length:
        raise DecodeError(f"{context}: expected {length} bytes, got {len(result)}")
    return result


def _decode_address(value: ScVal, context: str) -> str:
    return _expect(value, "address", context)


def _decode_string(value: ScVal, context: str) -> str:
    return _expect(value, "string", context)


def _decode_symbol(value: ScVal, context: str) -> str:
    return _expect(value, "symbol", context)


def _decode_fixed_bytes(value: ScVal, length: int, context: str) -> bytes:
    result = _expect(value, "bytes", context)
    if len(result) != length:
        raise DecodeError(f"{context}: expected {length} bytes, got {len(result)}")
    return result


def _decode_bytes(value: ScVal, length: int, context: str) -> bytes:
    if length >= 0:
        return _decode_fixed_bytes(value, length, context)
    return _expect(value, "bytes", context)


def _decode_option(value: ScVal, decode: Callable[[ScVal], Any], context: str) -> Any:
    return None if value.kind == "void" else decode(value)


def _vec_items(value: ScVal, context: str) -> tuple[ScVal, ...]:
    items = _expect(value, "vec", context)
    if items is None:
        raise DecodeError(f"{context}: expected a present vec")
    return items


def _decode_vec(value: ScVal, decode: Callable[[ScVal], Any], context: str) -> list[Any]:
    return [decode(item) for item in _vec_items(value, context)]


def _struct_fields(value: ScVal, context: str) -> dict[str, ScVal]:
    entries = _expect(value, "map", context)
    if entries is None:
        raise DecodeError(f"{context}: expected a present map")
    result: dict[str, ScVal] = {}
    for key, item in entries:
        name = _expect(key, "symbol", f"{context} map key")
        if name in result:
            raise DecodeError(f"{context}: duplicate field {name}")
        result[name] = item
    return result


def _field(fields: dict[str, ScVal], name: str, context: str) -> ScVal:
    try:
        return fields[name]
    except KeyError as error:
        raise DecodeError(f"{context}: missing field {name}") from error


def _optional_field(
    fields: dict[str, ScVal],
    name: str,
    decode: Callable[[ScVal], Any],
    context: str,
) -> Any:
    value = fields.get(name)
    if value is None or value.kind == "void":
        return None
    return decode(value)


def _enum_tag(value: ScVal, context: str) -> str:
    if value.kind == "symbol":
        return value.value
    items = _vec_items(value, context)
    if len(items) != 1:
        raise DecodeError(f"{context}: expected one enum symbol")
    return _expect(items[0], "symbol", context)


def _topic(topics: tuple[ScVal, ...], index: int, name: str) -> ScVal:
    try:
        return topics[index]
    except IndexError as error:
        raise DecodeError(f"event {name} is missing topic {index}") from error


def decode_contract_event(encoded: bytes | str) -> ContractEvent:
    reader = _Reader(_raw_xdr(encoded))
    if reader.i32() != 0:
        raise DecodeError("unsupported ContractEvent extension")
    contract_id = None
    if reader.boolean():
        contract_id = decode_strkey(16, reader.read(32))
    event_type = reader.i32()
    if event_type not in (0, 1):
        raise DecodeError(f"unsupported ContractEvent type {event_type}")
    if reader.i32() != 0:
        raise DecodeError("unsupported ContractEvent body")
    count = reader.count(4)
    topics = tuple(_read_scval(reader) for _ in range(count))
    data = _read_scval(reader)
    reader.expect_end()
    return ContractEvent(contract_id, event_type, topics, data)


def _read_preconditions(reader: _Reader) -> None:
    precondition_type = reader.i32()
    if precondition_type == 0:
        return
    if precondition_type == 1:
        reader.u64()
        reader.u64()
        return
    if precondition_type != 2:
        raise DecodeError("unsupported transaction preconditions")
    if reader.boolean():
        reader.u64()
        reader.u64()
    if reader.boolean():
        reader.u32()
        reader.u32()
    if reader.boolean():
        reader.u64()
    reader.u64()
    reader.u32()
    signers = reader.u32()
    if signers > 2:
        raise DecodeError("too many transaction precondition signers")
    for _ in range(signers):
        signer_type = reader.i32()
        if signer_type in (0, 1, 2):
            reader.read(32)
        elif signer_type == 3:
            reader.read(32)
            if len(reader.variable_bytes()) > 64:
                raise DecodeError("signed-payload precondition exceeds 64 bytes")
        else:
            raise DecodeError(f"unsupported precondition signer type {signer_type}")


def decode_invoke_contract_args(encoded: bytes | str) -> InvokeContractArgs:
    reader = _Reader(_raw_xdr(encoded))
    if reader.i32() != 2 or reader.i32() != 0:
        raise DecodeError("expected a v1 envelope with an ed25519 source")
    reader.read(32)
    reader.u32()
    reader.i64()
    _read_preconditions(reader)
    if reader.i32() != 0:
        raise DecodeError("expected a void memo")
    if reader.count(12) != 1:
        raise DecodeError("expected exactly one transaction operation")
    if reader.u32() != 0:
        raise DecodeError("expected an operation without a source account")
    if reader.i32() != 24 or reader.i32() != 0:
        raise DecodeError("expected an invokeContract operation")
    contract = _read_address(reader)
    function = reader.string()
    count = reader.count(4)
    args = []
    for _ in range(count):
        start = reader.offset
        _read_scval(reader)
        args.append(reader.data[start:reader.offset])
    if reader.u32() != 0:
        raise DecodeError("expected an invokeContract operation without authorization entries")
    if reader.i32() != 0:
        raise DecodeError("unsupported transaction extension")
    signatures = reader.count(8)
    for _ in range(signatures):
        reader.read(4)
        reader.variable_bytes()
    reader.expect_end()
    return InvokeContractArgs(contract, function, tuple(args))
