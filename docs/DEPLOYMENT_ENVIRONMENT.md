# Deployment environment roles

ArtFi separates backend/data services from UI and public-chain execution. Hostnames,
network routes, credentials and account-specific settings are deployment configuration.
They are not product defaults.

| Role | Responsibility |
| --- | --- |
| Backend/data zone | API, database and non-chain services; applicable data-residency controls |
| Public-chain execution zone | UI, public-chain RPC, indexing, simulation and broadcast |
| Model provider | Replaceable operations and proofreading interface |

The UI reaches the backend through a configured authenticated bridge. Do not assume
that the backend runs on the UI host or on a fixed port. Keep public URLs complete,
including their configured port and entry path, and preserve existing listeners and
unrelated services during upgrades.

Model output is advisory. No prompt, schema or transaction-control path may depend
on one vendor's identity or treat model output as transaction authority.

Registries, custodians and evidence providers are independently configured sources.
Infrastructure hosting does not imply an endorsement or exclusive partnership.

## Compatibility boundaries

The operations-dependency contract uses `artfi-delivery-link` internally. Its frozen
producer role is accepted only by the explicit schema-v2 compatibility boundary;
regression tests reject unknown roles and prevent legacy values from becoming new
internal roles. The mint-batch verifier also consumes a legacy field in the frozen
mint evidence. These executable schema bindings cannot be renamed in documentation
or historical evidence alone: any migration must preserve versioned compatibility
and verify its consumers.

The MySQL runtime contract is documented in
[MYSQL_DEPLOYMENT_CONTRACT.md](MYSQL_DEPLOYMENT_CONTRACT.md). Application
image builds and configured routing are documented in
[UI_DEPLOYMENT_CONTRACT.md](UI_DEPLOYMENT_CONTRACT.md).
