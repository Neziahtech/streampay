from __future__ import annotations

from typing import Any


class SDKError(Exception):
    pass


class EncodeError(SDKError):
    pass


class DecodeError(SDKError):
    pass


class ContractError(SDKError):
    def __init__(self, code: int, name: str, error: Any) -> None:
        super().__init__(f"{name} ({code})")
        self.code = code
        self.name = name
        self.error = error
