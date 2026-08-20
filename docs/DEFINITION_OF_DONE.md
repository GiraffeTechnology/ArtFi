# Definition of Done

A requirement is done only when all applicable items are satisfied:

- Acceptance criteria are linked to the PRD requirement ID.
- Code is reviewed and merged through a passing pull request.
- Unit and integration tests cover success, failure, authorization, and recovery paths.
- Security-sensitive changes include a threat assessment.
- User-facing changes include loading, empty, error, mobile, and accessibility states.
- API and data changes include migration, rollback, idempotency, and observability evidence.
- Contract changes include unit, fuzz, invariant, deployment simulation, and bytecode verification evidence.
- Documentation and runbooks are updated.
- No secret, personal data, private key, or production credential is committed.
- The deployed artifact maps to a versioned source commit and build provenance.

Screenshots and manually observed success are supporting evidence, not completion by themselves.
