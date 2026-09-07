# Dedicated CTYun database CI gate

The user's deployment boundary requires all database execution on the dedicated
CTYun MySQL server. GitHub-hosted, application, model and SIN hosts must not start
a substitute MySQL service. No production database or customer data is used.

The previous quality workflow started a local Docker database. This change
removes that execution path while preserving the migration job as an explicit,
non-optional failure: CTYUN_DB_EXECUTION_NOT_CONFIGURED. It neither skips the
requirement nor emits a successful check in place of migration evidence.

The other CI jobs remain runnable. A source milestone may be reviewed as a draft;
the red migration job prevents a claim of complete CI or final acceptance.
The accompanying policy regression tests prove only the fixed fail-closed
workflow structure, not database readiness.

To replace this temporary gate, the dedicated managed executor must actually
perform the required empty-schema forward migrations, integration tests,
backup, isolated restore, verification and reverse migrations on the same
candidate. Its authenticated connection and test-schema authority remain
external, protected runtime configuration. No credential, endpoint or secret
location is included here. Executor/profile schema validation alone is not
runtime evidence. Do not replace exit 1 with exit 0, continue-on-error or if:false.

Enabling the real matrix is a subsequent reviewed change with same-head evidence.
No local-DB fallback, automatic database installation, cutover, signing,
broadcast, Qwen call or operations-agent behavior is introduced by this patch.
