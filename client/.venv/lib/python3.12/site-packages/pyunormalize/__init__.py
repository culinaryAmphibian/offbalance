"""Pure-Python implementation of the Unicode normalization algorithm.

This zero-dependency package provides functions for applying the four
Unicode normalization forms (NFC, NFD, NFKC, and NFKD). It relies on generated
lookup tables built from the Unicode Character Database (UCD) associated with
Unicode 18.0.0.

Because it does not depend on third-party packages or the standard library
`unicodedata` module, it guarantees consistent behavior across all supported
Python environments (Python 3.9+), ensuring strict compliance with the rules
and definitions of Unicode 18.0.0.

Copyright (c) 2021-2026, Marc Lodewijck
Licensed under the terms of the MIT License.
"""

from typing import TYPE_CHECKING

from ._internal import UNICODE_VERSION
from ._version import __version__ as _pkg_version

UCD_VERSION = UNICODE_VERSION
__version__ = _pkg_version

del _pkg_version

if TYPE_CHECKING:
    from pyunormalize.normalization import (
        NFC,
        NFD,
        NFKC,
        NFKD,
        normalize,
    )

__all__ = (
    "NFC",
    "NFD",
    "NFKC",
    "NFKD",
    "UCD_VERSION",
    "UNICODE_VERSION",
    "__version__",
    "normalize",
)

_LAZY_EXPORTS = {"NFC", "NFD", "NFKC", "NFKD", "normalize"}


def __getattr__(name: str):
    if name in _LAZY_EXPORTS:
        from pyunormalize import normalization

        value = getattr(normalization, name)
        globals()[name] = value
        return value

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
