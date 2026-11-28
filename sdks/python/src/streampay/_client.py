from __future__ import annotations

from typing import Protocol, Sequence


XdrResult = bytes | str


class ReadTransport(Protocol):
    def simulate(self, method: str, args: Sequence[bytes]) -> XdrResult:
        """Return the base64 XDR (or raw XDR bytes) of one read result."""
        ...
