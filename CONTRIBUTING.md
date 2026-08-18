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
(cd apps/api && go test ./...)
```

Changes to smart contracts additionally require unit, fuzz, invariant, integration, and deployment simulation evidence.

## Security

Do not commit secrets, seed phrases, private keys, RPC credentials, production addresses, database dumps, or signed transactions. See [SECURITY.md](SECURITY.md).
