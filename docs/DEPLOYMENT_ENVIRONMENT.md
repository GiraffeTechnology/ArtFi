# Deployment environment

**This file is the only place in the repository that names a real deployment vendor, and it is
built to be deleted.**

Client ruling of 2026-09-19: the deployment environment may be written to GitHub, and must be
removable at any time. This repository is **private**. It is on GitHub so external auditors and VC
auditors can read it, not for public distribution.

---

## How to delete it

```bash
git rm docs/DEPLOYMENT_ENVIRONMENT.md
```

That is the whole operation. Nothing else needs editing:

- governing documents (`README.md`, `AGENTS.md`, `docs/PRD.md`, the directives) refer to
  **placeholders and roles**, never to a vendor;
- with this file gone, every one of those documents still reads correctly — it simply stops
  resolving to a named vendor.

**Keep it that way.** A vendor name written into a governing document, a code path, a test fixture
or a contract value breaks deletability: removing it then becomes a repository-wide edit with
behaviour risk, not a single `git rm`.

---

## Bindings

| Placeholder          | Deployment environment                                   | Holds                                          |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `<CLOUD_PROVIDER_A>` | CTYun, existing abcdyi and mysql servers                 | Backend, database and non-chain services       |
| `<CLOUD_PROVIDER_B>` | Alibaba Cloud, Singapore region — the SIN execution zone | UI and public-chain execution                  |
| `<LLM_PROVIDER_A>`   | Qwen API                                                 | Operations-agent and proofreading model access |

The client clarified the current split on 2026-10-02: backend, data and non-chain
services run on the existing CTYun abcdyi and mysql servers; public-chain execution
and the UI run on the existing SIN server. Reuse the existing bridge and 24/7
operations. This latest clarification controls the affected deployment placement.

### The model vendor is swappable

The client's ruling is explicit: **ArtFi is not in that vendor's ecosystem, and the model may be
changed at any time.** `<LLM_PROVIDER_A>` names today's provider and nothing more. No prompt,
schema, control path or test may depend on one model vendor's behaviour, and model output stays
advisory — transaction authority comes from deterministic policy (`AGENTS.md` §6).

---

## What this file does **not** cover

**Partner and ecosystem identities stay placeholders regardless of this ruling.** #110 §4 is a
separate P0 rule with a different purpose: it prevents ArtFi from implying an endorsement,
partnership or ecosystem relationship that does not exist. A deployment vendor is infrastructure
ArtFi rents; a registry partner is a relationship ArtFi claims.

| Category               | Example                | Naming                         |
| ---------------------- | ---------------------- | ------------------------------ |
| Deployment environment | Which cloud runs MySQL | May be named — here, only here |
| Partner / ecosystem    | `<REGISTRY_CHAIN_A>`   | **Placeholder always**         |

`<REGISTRY_CHAIN_A>` — the third-party registry chain for whole-artwork registration — is a partner,
not an environment. It is not resolved in this file and must not be named elsewhere.

---

## Known deviation

Deletability is **not yet true**. The operations-dependency behavioural contract now uses the
vendor-neutral host role `artfi-delivery-link`. The frozen r2 producer's legacy
role is accepted only by the versioned compatibility boundary; its regression
tests reject unknown producer roles and prevent the legacy value from becoming
ArtFi's internal role.
deployment-specific value. The Agent durable-store contract names the database by the
`<CLOUD_PROVIDER_A>` role rather than a vendor.

One executable compatibility exception remains explicit:
`scripts/release/verify-ye-yongrun-mint-batch.mjs` reads the legacy
`infrastructureAttestation.abcdyiSshRecovered` field from the already-recorded
`release/mint-batches/ye-yongrun-unit-a01-a38.intent.json`. That field is historical evidence, not
a permitted name for a new deployment contract. A future versioned evidence schema must replace it
with a role-named field; silently renaming the existing evidence would destroy compatibility. Real
vendor names also remain in historical and operational documents, including a file whose name is a
vendor name (`docs/CTYUN_MYSQL_DEPLOYMENT_CONTRACT.md`).

Until those documents and the versioned compatibility field are consolidated, deleting this file
removes the binding table but **not** every vendor name elsewhere. Recorded as a known deviation
rather than presented as satisfied.

## Client-supplied reuse instruction — 2026-10-02

The client identified an existing `artcch.com` build on the established servers and
asked to reuse it as much as possible, specifically because of the existing bridge
and 24/7 operations. The subsequent explicit placement clarification is reflected
in the binding table above. The ArtFi delivery destination
remains `https://io.artcch.com`. These are client-supplied location labels, not a verified
inventory of hosts, virtual hosts, running processes or files.

The existing task named `artfi` owns the previously authorized upload/deployment workflow.
Before changing a running service, that task should inspect the old build and its existing
source revision, image/process, API mapping and public build settings; establish how the
`artcch.com` site relates to the ArtFi application; and reuse compatible artifacts, dependencies
and configuration. The SIN UI must reach the backend through the existing bridge;
do not assume that port 8080 on the UI host is the backend. Resolve the actual
upstream from the original task's existing configuration. Preserve the existing
separate site if it is not the ArtFi target. Do not
replace or repoint `artcch.com` merely because the requested destination is its `io` subdomain.

No server filesystem, process, reverse-proxy rule or deployment credential was inspected during
the current cloud implementation slice: no usable server executor/task connection was available.
The implementation handoff is `docs/DELIVERY_2026-10-02_WEB_SLICE.md`; it does not authorize a new
hosting environment, a mainnet transaction or an unrelated site migration.
