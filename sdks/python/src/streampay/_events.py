from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
from typing import Any, ClassVar


def canonical(value: Any) -> Any:
    if isinstance(value, Enum):
        return canonical(value.value)
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: canonical(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


class CanonicalMixin:
    def to_dict(self) -> dict[str, Any]:
        return canonical(self)


@dataclass(frozen=True)
class EventBase(CanonicalMixin):
    contract_id: str
    name: ClassVar[str]
    topic_fields: ClassVar[tuple[str, ...]] = ()
    data_fields: ClassVar[tuple[str, ...]] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "contract": self.contract_id,
            "name": self.name,
            "topics": {name: canonical(getattr(self, name)) for name in self.topic_fields},
            "data": {name: canonical(getattr(self, name)) for name in self.data_fields},
        }
