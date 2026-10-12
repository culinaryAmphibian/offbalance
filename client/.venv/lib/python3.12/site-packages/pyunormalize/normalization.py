"""Core functions for Unicode normalization.

This module provides the main functions for applying the four Unicode
normalization forms: NFC, NFD, NFKC, and NFKD.

It relies on generated lookup tables built from the Unicode Character
Database (UCD). To keep module imports lightweight and fast, runtime tables
are loaded lazily and cached on first use.
"""

import importlib
from functools import cache

from pyunormalize._internal import UNICODE_VERSION

__all__ = ("NFC", "NFD", "NFKC", "NFKD", "normalize")


# --- Table loader ------------------------------------------------------------

def _load_module(module_name):
    """Lazily load an internal submodule and verify its Unicode version.

    Runtime data is loaded lazily to keep imports lightweight. The first
    normalization call pays the import cost of the required tables; subsequent
    calls use cached references and avoid repeated imports.
    """
    module = importlib.import_module(f"pyunormalize._internal.{module_name}")

    if module.UNICODE_VERSION != UNICODE_VERSION:
        raise RuntimeError(
            f"Unicode version mismatch in {module_name!r} "
            f"(expected {UNICODE_VERSION!r}, "
            f"found {module.UNICODE_VERSION!r})."
        )

    return module


# --- Data tables (lazy and cached) -------------------------------------------

@cache
def _ccc():
    return _load_module("non_zero_ccc_table").NON_ZERO_CCC_TABLE


@cache
def _nfd_qc_no():
    return _load_module("nfd_qc_no").NFD_QC_NO


@cache
def _nfkd_qc_no():
    return _load_module("nfkd_qc_no").NFKD_QC_NO


@cache
def _nfc_qc_no_or_maybe():
    return _load_module("nfc_qc_no_or_maybe").NFC_QC_NO_OR_MAYBE


@cache
def _nfkc_qc_no_or_maybe():
    return _load_module("nfkc_qc_no_or_maybe").NFKC_QC_NO_OR_MAYBE


@cache
def _cdecomp_table():
    return _load_module("canonical_decomposition").FULL_CDECOMP_BY_CHAR


@cache
def _kdecomp_table():
    return _load_module("compatibility_decomposition").FULL_KDECOMP_BY_CHAR


@cache
def _composition_table():
    return _load_module("canonical_composition").COMPOSITE_BY_CDECOMP


# --- Public API --------------------------------------------------------------

def NFD(string):
    """Return the normalization form D of the input string.

    Replaces composed characters with their canonically equivalent decomposed
    forms in canonical order, while leaving compatibility characters
    unaffected.

    The function first checks if the input is already in NFD. If so, it returns
    the string unchanged to avoid unnecessary processing.

    Args:
        string (str): The string to be normalized.

    Returns:
        str: The NFD string.

    Examples:
        # Decomposing accented characters
        >>> text_latin = "élève"
        >>> nfd_latin = NFD(text_latin)
        >>> nfd_latin != text_latin  # binary content differs
        True
        >>> " ".join([f"{ord(c):04X}" for c in text_latin])
        '00E9 006C 00E8 0076 0065'
        >>> " ".join([f"{ord(c):04X}" for c in nfd_latin])
        '0065 0301 006C 0065 0300 0076 0065'

        # Decomposing Hangul syllables
        >>> text_hangul = "한국"
        >>> nfd_hangul = NFD(text_hangul)
        >>> " ".join([f"{ord(c):04X}" for c in text_hangul])
        'D55C AD6D'
        >>> " ".join([f"{ord(c):04X}" for c in nfd_hangul])
        '1112 1161 11AB 1100 116E 11A8'

        # Compatibility characters are unaffected
        >>> strings = ["ﬃ", "⑴", "²", "ｱｲｳｴｵ"]
        >>> all(NFD(s) == s for s in strings)
        True
    """
    return string if string.isascii() else _nfd_core(string, _ccc())


def NFC(string):
    """Return the normalization form C of the input string.

    Replaces character sequences with their canonically equivalent composed
    forms whenever possible, while leaving compatibility characters unaffected.

    The function first checks if the input is already in NFC. If so, it returns
    the string unchanged to avoid unnecessary processing.

    Args:
        string (str): The string to be normalized.

    Returns:
        str: The NFC string.

    Examples:
        # Composing accented characters
        >>> text_latin = "e\u0301le\u0300ve"
        >>> nfc_latin = NFC(text_latin)
        >>> nfc_latin != text_latin  # binary content differs
        True
        >>> " ".join([f"{ord(c):04X}" for c in text_latin])
        '0065 0301 006C 0065 0300 0076 0065'
        >>> " ".join([f"{ord(c):04X}" for c in nfc_latin])
        '00E9 006C 00E8 0076 0065'

        # Composing Hangul syllables
        >>> text_hangul = "\u1112\u1161\u11AB\u1100\u116E\u11A8"
        >>> nfc_hangul = NFC(text_hangul)
        >>> " ".join([f"{ord(c):04X}" for c in text_hangul])
        '1112 1161 11AB 1100 116E 11A8'
        >>> " ".join([f"{ord(c):04X}" for c in nfc_hangul])
        'D55C AD6D'

        # Compatibility characters are unaffected
        >>> strings = ["ﬃ", "⑴", "²", "ｱｲｳｴｵ"]
        >>> all(NFC(s) == s for s in strings)
        True
    """
    if string.isascii():
        return string

    ccc = _ccc()

    if _quick_check(string, _nfc_qc_no_or_maybe(), ccc):
        return string

    return _compose(_nfd_core(string, ccc), ccc, _composition_table())


def NFKD(string):
    """Return the normalization form KD of the input string.

    Replaces composed characters with their canonically equivalent decomposed
    forms in canonical order and converts compatibility characters into their
    nominal counterparts.

    The function first checks if the input is already in NFKD. If so, it
    returns the string unchanged to avoid unnecessary processing.

    Args:
        string (str): The string to be normalized.

    Returns:
        str: The NFKD string.

    Examples:
        # NFKD decomposes canonically composed forms
        >>> NFKD("\u00E9l\u00E8ve") == "e\u0301le\u0300ve"
        True

        # NFKD converts compatibility characters
        >>> [NFKD(s) for s in ["ﬃ", "⑴", "²", "ｱｲｳｴｵ"]]
        ['ffi', '(1)', '2', 'アイウエオ']
    """
    return string if string.isascii() else _nfkd_core(string, _ccc())


def NFKC(string):
    """Return the normalization form KC of the input string.

    Replaces character sequences with their canonically equivalent composed
    forms whenever possible and converts compatibility characters into their
    nominal counterparts.

    The function first checks if the input is already in NFKC. If so, it
    returns the string unchanged to avoid unnecessary processing.

    Args:
        string (str): The string to be normalized.

    Returns:
        str: The NFKC string.

    Examples:
        # NFKC composes canonically decomposed forms
        >>> NFKC("e\u0301le\u0300ve") == "\u00E9l\u00E8ve"
        True

        # NFKC converts compatibility characters
        >>> [NFKC(s) for s in ["ﬃ", "⑴", "²", "ｱｲｳｴｵ"]]
        ['ffi', '(1)', '2', 'アイウエオ']
    """
    if string.isascii():
        return string

    ccc = _ccc()

    if _quick_check(string, _nfkc_qc_no_or_maybe(), ccc):
        return string

    return _compose(_nfkd_core(string, ccc), ccc, _composition_table())


# Dictionary for normalization forms dispatch
_NORMALIZATION_FORMS = {"NFC": NFC, "NFD": NFD, "NFKC": NFKC, "NFKD": NFKD}


def normalize(form, string):
    """Return the normalized form of the input string as specified by `form`.

    This function transforms the input string according to the normalization
    form given in `form`. Supported values are "NFC", "NFD", "NFKC",
    and "NFKD".

    Args:
        form (str): The normalization form to apply, one of "NFC", "NFD",
            "NFKC", or "NFKD".

        string (str): The string to be normalized.

    Returns:
        str: The normalized string.

    Examples:
        >>> normalize("NFKD", "ﬂuﬃness")
        'fluffiness'

        >>> forms = ["NFC", "NFD", "NFKC", "NFKD"]
        >>> string = "\u1E9B\u0323"
        >>> def hexpoints(s):
        ...     return " ".join([f"{ord(c):04X}" for c in s])
        >>> [hexpoints(normalize(f, string)) for f in forms]
        ['1E9B 0323', '017F 0323 0307', '1E69', '0073 0323 0307']
    """
    try:
        func = _NORMALIZATION_FORMS[form]
    except KeyError:
        raise ValueError(
            f"Invalid normalization form {form!r} "
            f"(expected one of: {', '.join(_NORMALIZATION_FORMS)})."
        ) from None

    return func(string)


# --- Hangul constants --------------------------------------------------------

# Hangul syllables for modern Korean
_SB = 0xAC00
_SL = 0xD7A3

# Hangul leading consonants (syllable onsets)
_LB = 0x1100
_LL = 0x1112

# Hangul vowels (syllable nuclei)
_VB = 0x1161
_VL = 0x1175

# Hangul trailing consonants (syllable codas)
_TB = 0x11A8
_TL = 0x11C2

# Number of Hangul vowels
_VCOUNT = 21

# Number of Hangul trailing consonants (27 codas + 1 for no coda)
_TCOUNT = 27 + 1


# --- Internal algorithms -----------------------------------------------------

def _nfd_core(string, ccc):
    """Perform core canonical decomposition on a non-ASCII string."""
    if _quick_check(string, _nfd_qc_no(), ccc):
        return string
    return _reorder(_decompose(string, _cdecomp_table()), ccc)


def _nfkd_core(string, ccc):
    """Perform core compatibility decomposition on a non-ASCII string."""
    if _quick_check(string, _nfkd_qc_no(), ccc):
        return string
    return _reorder(_decompose(string, _kdecomp_table()), ccc)


def _quick_check(string, quick_check_set, ccc_table):
    """Perform a quick check to verify if a string is already normalized.

    Check if the string is already normalized to the target form (NFC, NFD,
    NFKC, or NFKD). The normalization form checked is determined by the
    specific set of code points provided.
    """
    prev_ccc = 0

    for char in string:
        cp = ord(char)

        if cp in quick_check_set:
            return False

        # A ccc of 0 indicates a starter character, resetting the sequence
        if (curr_ccc := ccc_table.get(cp, 0)) == 0:
            prev_ccc = 0
            continue

        if curr_ccc < prev_ccc:
            return False

        prev_ccc = curr_ccc

    return True


def _decompose_hangul_syllable(cp):
    """Decompose a Hangul syllable into its constituent jamo code points.

    Decompose a precomposed Hangul syllable into its constituent jamo
    characters using the canonical Hangul decomposition algorithm.
    """
    sindex = cp - _SB
    tindex = sindex % _TCOUNT
    q = (sindex - tindex) // _TCOUNT
    V = _VB + (q  % _VCOUNT)
    L = _LB + (q // _VCOUNT)

    if tindex:
        return (L, V, _TB - 1 + tindex)  # LVT syllable

    return (L, V)  # LV syllable


def _compose_hangul_syllable(cp, next_cp):
    """Attempt to compose two Hangul code points into a single syllable.

    This function attempts to compose a sequence of Hangul characters into
    a single syllable using the specialized Hangul composition algorithm. It
    returns the new syllable's code point on success, or `None` if the pair
    of code points does not form a valid Hangul composition. The composition
    logic only applies to two specific scenarios: a leading consonant (L)
    is combined with a vowel (V), and in this case `cp` is L and `next_cp`
    is V; or a precomposed LV syllable is combined with a trailing
    consonant (T), and `cp` is then the LV syllable and `next_cp` is T.
    """
    if _LB <= cp <= _LL and _VB <= next_cp <= _VL:
        # Compose a leading consonant and a vowel into an LV syllable
        return _SB + (((cp - _LB) * _VCOUNT) + next_cp - _VB) * _TCOUNT

    if (
        _SB <= cp <= _SL
        and (cp - _SB) % _TCOUNT == 0
        and _TB <= next_cp <= _TL
    ):
        # Compose an LV syllable and a trailing consonant into an LVT syllable
        return cp + next_cp - (_TB - 1)

    # Composition did not take place
    return None


def _reorder(codepoints, ccc_table):
    """Reorder combining marks in a decomposed string into canonical order.

    Apply the canonical ordering algorithm to a fully decomposed string,
    arranging combining marks with a non-zero combining class value in
    a well-defined order. This ensures the uniqueness of normalization forms.
    """
    size = len(codepoints)

    # Outer loop: optimized bubble sort, runs as long as swaps occur
    while size > 1:
        swap_pos = 0

        i = 1
        while i < size:
            curr = codepoints[i]

            # Block check: if the current character is a starter (ccc is 0),
            # it acts as a blocker, and no reordering can happen across it
            if curr not in ccc_table:
                i += 2
                continue

            prev = codepoints[i - 1]

            # Reordering rule: order is correct if the previous character
            # is a starter or if ccc(prev) is less than or equal to ccc(curr)
            if prev not in ccc_table or ccc_table[prev] <= ccc_table[curr]:
                i += 1
                continue

            # Swap adjacent combining marks to enforce canonical order
            codepoints[i - 1], codepoints[i] = codepoints[i], codepoints[i - 1]

            swap_pos = i
            i += 1

        # Shrink the scope of the sort to the position of the last swap
        size = swap_pos

    return "".join(map(chr, codepoints))


def _decompose(string, decomp):
    """Decompose a string into canonical or compatibility code points.

    Perform full decomposition of the input string. Canonical decomposition
    is used for NFC/NFD, and compatibility decomposition for NFKC/NFKD.
    """
    codepoints = []

    for cp in map(ord, string):
        if (mapped := decomp.get(cp)) is not None:
            codepoints.extend(mapped)
        elif _SB <= cp <= _SL:
            codepoints.extend(_decompose_hangul_syllable(cp))
        else:
            codepoints.append(cp)

    return codepoints


def _compose(string, ccc_table, composite_by_cdecomp):
    """Combine eligible decomposed code points into precomposed characters.

    Apply the canonical composition algorithm, transforming the fully
    decomposed and canonically ordered string into its most fully composed
    but still canonically equivalent sequence.
    """
    codepoints = []

    # Most recent starter (a character with CCC 0): it is the candidate
    # for composition with subsequent code points
    starter_index = None

    # CCC of the previous retained combining mark: a value of 0 means
    # that no preceding mark blocks composition with the current starter
    last_ccc = 0

    # Process the decomposed code points from left to right
    for cp in map(ord, string):
        ccc = ccc_table.get(cp, 0)

        # A code point may compose with the current starter only when it is not
        # blocked by a retained mark of the same or higher CCC
        if starter_index is not None and (last_ccc == 0 or last_ccc < ccc):
            starter = codepoints[starter_index]
            pair = (starter, cp)

            # Look up ordinary canonical compositions first
            precomposed_char = composite_by_cdecomp.get(pair)

            if precomposed_char is None:
                # Check if the composition pair can be composed
                # using the Hangul algorithm
                precomposed_char = _compose_hangul_syllable(*pair)

            # Replace the starter when the pair has an allowed composite
            if precomposed_char is not None:
                codepoints[starter_index] = precomposed_char

                # The current character was consumed, it therefore cannot block
                # composition with the next character
                continue

        # No composition took place: retain the current character
        codepoints.append(cp)

        if ccc == 0:
            # A starter begins a new combining character sequence
            starter_index = len(codepoints) - 1
            last_ccc = 0
        else:
            # Retained marks can block later compositions in this sequence
            last_ccc = ccc

    return "".join(map(chr, codepoints))


if __name__ == "__main__":
    import doctest
    doctest.testmod(verbose=True)
