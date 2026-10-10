# Contributing

## Branches and pull requests

- Branch from `main` using `agent/<short-description>` or `feature/<short-description>`.
- Keep each pull request scoped to one stage outcome.
- Use draft pull requests until all required checks pass.
- Squash merge is preferred.

## Required checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
(cd apps/api && go vet ./... && go test -race ./...)
```

Changes to smart contracts additionally require unit, fuzz, invariant, integration, and deployment simulation evidence.

## Security

Do not commit secrets, seed phrases, private keys, RPC credentials, production addresses, database dumps, or signed transactions. See [SECURITY.md](SECURITY.md).

## Licensing and provenance

The project contains proprietary and separately licensed material. See
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the applicable scope.
Contributions must identify their origin and retain existing license,
copyright, and attribution notices. Submit only material you own or are
authorized to contribute under the applicable terms. Submission does not by
itself transfer copyright ownership or replace a third-party license.
