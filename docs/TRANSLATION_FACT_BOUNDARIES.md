# Authoritative facts in translated UI text

The existing eight-language module retains English as the authoritative source
for French, Spanish, German, Korean and Japanese. Primary translation and optional
proofreading still use the existing configured service. No additional provider,
credential or transaction permission is introduced.

Technical identity text stays in its original form and is not submitted for
translation, including an address, hash, URL or email embedded inside a sentence.
Nearby ordinary text nodes and accessible labels remain eligible for translation.

Translated text must preserve the exact multiset of numeric literals and the
recognized payment units, as well as the existing protected product terms.
Changed amounts, missing repeated quantities, altered signs or percentages,
different units, or newly introduced technical identities fail validation.
Formatting changes such as replacing a decimal point with a comma conservatively
fall back to the original copy. Actual UTF-8 output size remains bounded.

The validator runs on new upstream results, server cache reuse, browser memory
cache reuse and browser session-cache reuse. Invalid cached values are discarded;
an invalid fresh response restores authoritative copy through the existing
unavailable path. Safe translations and the original source fallback retain the
existing response format.

Literal equality is a display-integrity check. It does not prove translation
meaning, reserve funds, verify an asset or authorize an action. The exact review
terms, authentication, grants and contract-side checks remain authoritative.
Verification records distinguish synthetic unit/type checks from actual DOM,
configured-provider, browser and transaction acceptance.
