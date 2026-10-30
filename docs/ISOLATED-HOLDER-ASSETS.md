# Isolated holder preparation: development scope

This additive module extends the isolated-input validation stage. It preserves
the existing runtime, authentication and storage implementations. It performs
local preparation only and does not publish, grant access, start a service or
send a transaction. Preparation never establishes ownership or acceptance.

The module checks file identities, duplicate content, source separation,
canonical token identifiers, image headers, observed input drift and refusal
boundaries. Image-header checks do not prove decoded pixels, visible watermarks
or generation provenance. Independent runtime validation remains required.

The 24 authored synthetic Node fixture cases have not been executed by the
initial author. The assigned validation owner runs:

```sh
node --test scripts/test/isolated-holder-assets.test.mjs
```

Use the exact reviewed dependency stage before integration. Previous packaging
increments do not automatically include this module. Operational instructions,
deployment bindings, input artifacts and execution evidence remain in the
existing controlled private workflow and are not included in this document.
