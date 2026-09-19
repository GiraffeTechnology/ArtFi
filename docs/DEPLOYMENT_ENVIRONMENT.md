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
| `<CLOUD_PROVIDER_A>` | CTYun                                                    | Delivery and the MySQL database, domestic      |
| `<CLOUD_PROVIDER_B>` | Alibaba Cloud, Singapore region — the SIN execution zone | Public-chain operation only                    |
| `<LLM_PROVIDER_A>`   | Qwen API                                                 | Operations-agent and proofreading model access |

This keeps the deployment topology ruling of 2026-09-05 (#74): off-chain data stays domestic, and
only public-chain operation runs in the SIN execution zone.

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
vendor-neutral host role `artfi-delivery-link`, and its regression test rejects the former
deployment-specific value. Real vendor names still appear in historical and operational documents,
including a file whose name is a vendor name
(`docs/CTYUN_MYSQL_DEPLOYMENT_CONTRACT.md`).

Until those documents are consolidated here, deleting this file removes the binding table but
**not** every vendor name elsewhere. Recorded as a known deviation rather than presented as
satisfied.
