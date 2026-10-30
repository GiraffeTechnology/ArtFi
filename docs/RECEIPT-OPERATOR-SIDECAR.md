# Receipt operator tools sidecar

The native installation kit and the engineering release tools have different
directory layouts. The receipt verifier and isolated Hoodi input preparer use
the web package's existing ethers dependency through a relative source path.
Copying their two CLI files alone into a native kit does not provide that
dependency or their sibling library modules.

This separate builder preserves the source layout for the two tools, includes
only their installed ethers production graph, and records the selected source,
dependency contents, notices, file hashes, executable modes and relative links.
It does not change the native installer or copy a Node runtime. Use the existing
independently accepted Linux Node 24+ binary associated with the installation.

## Select the complete input first

The independent integration owner first assembles a clean, exact Git candidate
containing this builder, the existing package copier, both tools and their two
libraries and guides. This additive stage does not merge those independent
increments, certify their combined behavior or modify their submitted files.
The current main branch may lack one or both tools and must then fail inspection.

From the selected source checkout, the following command reads local source and
already installed dependencies and prints a candidate selection descriptor:

```sh
"$EXISTING_APPROVED_NODE" scripts/install/build-receipt-operator-sidecar.mjs \
  --inspect-dependencies > /controlled/selection-candidate.json
```

The descriptor has schema `artfi-receipt-operator-selection/v1`, the full Git
revision/tree, an exact 15-file source inventory and a dependency fingerprint.
Every source entry contains bytes and SHA-256. The fingerprint binds the observed
installed graph's relative package locations, names, versions, license labels,
notice paths, complete package files, dependency edges and missing optional
dependencies. It is a packaging identity, not a grant, receipt, policy or journal
commitment. Inspection is not independent approval of what it observes.

The integration owner must review the exact selected source, lockfile, installed
dependency provenance and notices before using that descriptor as the selection
input. It must not substitute a freshly generated descriptor to conceal drift
from an earlier reviewed input. The builder does not download/install packages,
choose new versions, infer dependency approval from a clean Git tree, or verify
registry signatures. The installed ethers version must exactly equal the source
web manifest's fixed version; all transitive bytes and graph edges are bound by
the separately selected fingerprint. Missing mandatory packages and notices fail.
Absent optional packages are explicitly listed; they are not silently installed.

Both source and existing dependency locations must be inside the physical
selected checkout. The controlled descriptor is a bounded regular JSON file;
symlink inputs and directory traversal are refused. Source file lists are exact,
not caller-selected arbitrary files. Project notices and the original public web
package manifest and lockfile accompany the sidecar. This is only a dependency
resolution context: it is not a packaged web application, and its other declared
dependencies are intentionally absent. Do not run a package manager there.

## Build into a new, separate directory

```sh
"$EXISTING_APPROVED_NODE" scripts/install/build-receipt-operator-sidecar.mjs \
  --selection /controlled/independently-selected-source.json \
  --output /controlled/new-receipt-tools
```

The output parent must already exist and be physical. The output must be outside
the source repository and must not exist. EEXIST fails without deletion,
overwrite, resume or cleanup. Build output contains:

- `engineering-source/scripts/release/`: the two original CLIs and libraries.
- `engineering-source/apps/web/package.json` and `node_modules/ethers`: the
  source-style resolution anchor and only its actual installed dependency graph.
- `engineering-source/docs/`: both exact tool guides and this sidecar guide; original project notices
  and the selected lockfile retain their source paths.
- `manifest.json`: exact selected source and dependency profile, complete payload
  file/link inventory and payload fingerprint. The returned manifest SHA-256 is
  separate because a manifest cannot contain its own content hash.

Existing package copying uses relative links in a private store. The builder
checks every copied byte, mode, package identity and dependency edge against its
observed source and rejects links escaping the payload, special files, unexpected
files and credential-style filenames. Package internal source symlinks are not
supported; ordinary installed node_modules links are resolved before copying.
Source and dependency identities are checked again after copying. This assumes a
controlled, stable build workspace; it does not lock arbitrary concurrent writers.

No CLI, dependency module, application, installer or service is executed by the
builder. The source tree and installed packages remain read-only. A failure after
directory creation leaves partial output in place without a completed manifest;
preserve and reconcile it. Use a separately selected new output directory only
after resolving the prior failure. The builder never archives, removes or retries
an unknown prior output automatically.

## Consume only under independent validation

The package status remains `PACKAGED_NOT_ACCEPTED`, with authorization
`NOT_ESTABLISHED`, `toolsExecuted: false` and `wholeProductAccepted: false`.
An inventory match is not evidence that a tool ran or an on-chain result passed.
The assigned validation owner must first run the fixture suite and an actual
sidecar build, then test the copied tools with the accepted private input corpus
and selected original provider/deployment bindings. Verify relocation and complete
link closure under the existing approved Node. No new runtime is needed.

```sh
"$EXISTING_APPROVED_NODE" --test scripts/test/receipt-operator-sidecar.test.mjs
"$EXISTING_APPROVED_NODE" /controlled/new-receipt-tools/engineering-source/scripts/release/prepare-isolated-hoodi-charity.mjs \
  /controlled/private-input
"$EXISTING_APPROVED_NODE" /controlled/new-receipt-tools/engineering-source/scripts/release/verify-hoodi-charity-atomic-receipt.mjs \
  /controlled/exact-private-expectations.json --rpc-env EXISTING_APPROVED_RPC
```

The final command performs read-only RPC verification and requires a separately
observed completed execution. It must not be run as a substitute for missing
runtime identity, quorum, authorization, human signature, canonical/finality,
unknown-outcome reconciliation, UI or complete-product evidence. Preparation
does not sign, publish, broadcast or establish authority. No private images,
metadata inputs, endpoint values, credentials or live configuration belong in
the sidecar or public repository.

This initial stage includes 20 authored synthetic Node fixture tests. The author
has not executed them, built a sidecar, started a tool or queried an RPC. Ordinary
testing, integration and all post-submission modifications belong to the assigned
independent validation owner. Final accepted source, selected dependency profile,
sidecar and manifest require the existing project Giraffe archive mechanism with
full independent byte readback. No source release follows from packaging alone.
