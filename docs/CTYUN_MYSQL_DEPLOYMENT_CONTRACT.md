# CTYun MySQL Deployment Contract

Status: **GATED - network route confirmed; database identity, credentials, and TLS not confirmed**

ArtFi production persistence must use the CTYun MySQL service. The MySQL container in
`docker-compose.yml` remains local/integration-test infrastructure only and must not be used as the
production database.

## Confirmed network route

- Application-side endpoint on abcdyi: `localhost` plus the protected runtime tunnel port
- Tunnel service: `giraffe-mysql-tunnel.service`
- Tunnel unit: `/home/dev/.config/systemd/user/giraffe-mysql-tunnel.service`
- Routed path: abcdyi loopback -> AIVAN backend alias -> CTYun MySQL backend alias; exact targets
  and ports remain in protected systemd/runtime configuration outside Git
- Expected application database name: `artfi`
- Runtime environment variable already consumed by the API: `MYSQL_DSN`

The application must connect only through the localhost endpoint. The CTYun private target must not
be exposed publicly or hard-coded into application source.

## Fail-closed runtime contract

Production startup must receive `MYSQL_DSN` from an approved secret manager or protected runtime
environment. Its value must never be committed, printed, included in CI, or copied into tickets or
chat. The DSN must select database `artfi`, enable `parseTime=true`, use an explicit connection
timeout, and apply the TLS mode approved for the CTYun service.

No production deployment is authorized until all of the following are confirmed:

1. Database `artfi` exists on the CTYun target.
2. A least-privilege ArtFi application user exists and is not a MySQL root account.
3. The secret-manager/runtime-env location and rotation owner are documented.
4. Database-layer TLS mode, CA path, server-name verification, and any client-certificate requirement
   are documented and tested.
5. The tunnel service owner, restart policy, health monitoring, and alert route are documented.
6. All five migrations apply to an isolated CTYun staging database and roll back cleanly.
7. Backup encryption, RPO/RTO, immutable copy, and restore-test evidence satisfy the operations
   runbook.

## Environment boundary

- `MYSQL_DSN`: production application runtime connection; secret value.
- `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`: configuration inputs only where the deployment
  platform composes the secret DSN; values remain secret.
- `ARTFI_INTEGRATION_MYSQL_DSN`: integration tests only; never point it at production.
- `MYSQL_ROOT_PASSWORD`: local Compose/bootstrap only; never use it for the ArtFi production API.

Until the missing controls are confirmed, retain the API's existing fail-closed behavior when
`MYSQL_DSN` is absent or unusable. Do not fall back to in-memory or local Compose persistence in
production.

## Operator boundary

An active tunnel or open loopback listener proves only the transport route; it does not prove
MySQL authentication, database-layer TLS, schema readiness, or application persistence. Authorized
operators may verify the exact systemd user service and expected loopback listener without a
database login. They must not probe alternate ports, bypass the tunnel, weaken TLS verification,
or print the resolved DSN. Authentication and migrations begin only after the approved secret and
TLS policy are available.
