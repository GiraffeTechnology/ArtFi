# AIVAN translation runtime contract

## Purpose and trust boundary

ArtFi provides one global `EN / 简 / 繁 / FR / ES / DE / 한 / 日` selector across every public
route. Visible menu copy stays compact while each option exposes its complete language name to
assistive technology. Translation is generated only by the dedicated AIVAN language service. The
AIVAN general-purpose Qwen model is not a translation provider and may only proofread a completed
primary translation.

The production path is:

```text
ArtFi same-origin API
  -> SIN portal loopback tunnel
  -> abcdyi loopback tunnel
  -> isolated AIVAN ArtFi language service
  -> CTranslate2 + pinned OPUS-MT/M2M100 primary translation
  -> OpenCC conversion for Traditional Chinese
  -> optional qwen3.5:9b proofread-only pass
```

Every hop is loopback-only or an authenticated managed tunnel. Runtime endpoints, credentials,
server addresses and key material are environment configuration and must not be committed.

## Approved primary models

| Direction                      | Model                                               | Immutable revision                         | Licence    | Runtime                   |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------ | ---------- | ------------------------- |
| English to Simplified Chinese  | `Helsinki-NLP/opus-mt-en-zh`                        | `408d9bc410a388e1d9aef112a2daba955b945255` | Apache-2.0 | CTranslate2 int8          |
| English to Traditional Chinese | English-to-Chinese model followed by OpenCC `s2twp` | same model revision                        | Apache-2.0 | CTranslate2 int8 + OpenCC |
| English to French              | `Helsinki-NLP/opus-mt-en-fr`                        | `dd7f6540a7a48a7f4db59e5c0b9c42c8eea67f18` | Apache-2.0 | CTranslate2 int8          |
| English to Spanish             | `Helsinki-NLP/opus-mt-en-es`                        | `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | Apache-2.0 | CTranslate2 int8          |
| English to German              | `Helsinki-NLP/opus-mt-en-de`                        | `6183067f769a302e3861815543b9f312c71b0ca4` | CC-BY-4.0  | CTranslate2 int8          |
| English to Korean              | `facebook/m2m100_418M`                              | `55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636` | MIT        | CTranslate2 int8          |
| English to Japanese            | `facebook/m2m100_418M`                              | `55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636` | MIT        | CTranslate2 int8          |

Model weights are server-local release artifacts. Their per-file SHA-256 manifest must be retained
with the deployed release and must never be committed to GitHub.

French, Spanish, German, Korean and Japanese must always use authoritative English source copy;
Chinese output must never be used as an intermediate translation source. The UI locale `zht` maps
to the existing service target `zh-Hant`, preserving the established Traditional Chinese API and
cache contract.

## Qwen proofreader invariant

The proofreader receives both source text and the completed primary translation. Its system
instruction identifies it as a proofreader rather than a translator. A response is accepted only
when it is valid structured output and preserves protected product terms, numeric facts and minimum
semantic similarity. The response reports `role=proofread-only` and one of `accepted`, `revised`,
`unavailable` or `rejected`.

If the proofreader times out, is unavailable, changes protected facts or fails validation, ArtFi
returns the unchanged primary translation with a typed warning. Qwen must never become a fallback
translation generator.

## Fail-closed production acceptance

Production translation is not accepted when any of the following is true:

- `/v1/models` reports `mock`, Qwen or an unknown provider as the primary translator;
- any pinned primary model or the complete local hash manifest is missing;
- the Qwen integration does not report the proofread-only role;
- failure of Qwen discards or replaces a valid primary translation;
- a public route lacks the shared eight-language selector or complete accessible option names;
- a server or tunnel listens on a public interface;
- runtime addresses, credentials, keys, secrets or model weights appear in Git history.

Acceptance evidence must include health and model responses, representative English-to-each-target
translations, proof that FR/ES/DE/KO/JA use English directly, a forced proofreader failure test,
service restart evidence, tunnel auto-reconnect evidence and public-route browser checks. Evidence
must be sanitized and bound to the deployed source commit and model hash manifest.

## Customer-service and operations boundary

AIVAN `qwen3.5:9b` may separately support customer service and operations through authenticated,
RBAC-protected, rate-limited and audited APIs. That workflow is not part of translation generation,
must not share the public translation endpoint, and must fail closed for privileged actions. No AI
response may directly sign transactions, change infrastructure, disclose personal data or bypass a
human approval gate.

## Multilingual runtime evidence - 2026-08-21

- Translation source commit `79e3fa4` passes Ruff and 47 pytest assertions in the isolated abcdyi
  environment; it has not been pushed and has not triggered GitHub CI.
- The ArtFi-only model release contains six primary model directories and a 42-file SHA-256 manifest;
  every file verifies. Model weights remain outside Git.
- The dedicated AIVAN production service advertises CTranslate2 for `en-zh`, `en-zh-Hant`, `en-fr`, `en-es`,
  `en-de`, `en-ko` and `en-ja`. One protected-term/numeric-fact probe per target returns without a
  warning.
- Localized decimal punctuation is accepted only when its parsed numeric value and currency/unit are
  unchanged; different values continue to fail closed.
- A bounded four-worker cold-start probe creates one process provider and loads only the requested
  `en-fr` model. The service remains active with zero restarts after the immutable code-release switch.
- A forced Qwen outage preserves the CTranslate2 primary result and returns typed
  `PROOFREAD_FAILED`; Qwen is advertised only as `proofread-only`.
- Both abcdyi loopback compatibility endpoints resolve through the managed tunnel to the dedicated
  AIVAN service. The shared AIVAN translation service is not modified.

This evidence validates the private translation runtime only. It does not authorize a public portal
release, GitHub push or GitHub CI run.
