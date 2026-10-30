# Packaged read-only monitor implementations

The native artifact carries the existing format-1 sampler in `tools/operations`
and the durable monitor in `tools/ops`. Both use the artifact's existing
`runtime/bin/node`. No model, notification channel, service user, scheduler,
credentials or production configuration is supplied or enabled by packaging.

The installer retains `ARTFI_MONITOR_ENABLED` and `ARTFI_MONITOR_CONFIG_FILE`.
There is no new deployment parameter. An enabled monitor's private, external
descriptor selects the implementation explicitly:

- `format: 1`, without `schemaVersion`: the existing sampler with `--watch`.
- `schemaVersion: 1`, `mode: "monitor-only"`, without `format`: the durable
  monitor service. Its own inventory, environment, check and STOP controls apply.
- Missing, unknown or ambiguous discriminators are refused before starting a child.

Descriptors must remain private regular files outside the immutable artifact.
The selector reads at most 256 KiB and requires valid UTF-8 JSON. Neither parse
errors nor descriptor content is printed. Selection does not grant an endpoint,
identity, storage path, model, notification route or financial authority. Existing
format-1 files are not automatically converted to the durable schema.

For an approved durable deployment, supply its verified `hostRole`, independent
absolute `stateDirectory` and `stopFile`, environment, interval and check inventory
according to `tools/ops/README.md`. A host-capacity check also requires the actual
deployment's absolute disk path. No path or resource binding is guessed. Preserve
the existing installation's assigned runtime, ports, identities and configuration.

To exercise one explicitly configured durable tick from an extracted, verified
artifact, use the bundled Node and `tools/ops/monitor-service.mjs` with the private
descriptor and `--once`. This is an operational action requiring the normal target
and state-directory authorization; merely reading this guide does not run it.
The shipped `artfi-monitor@.service` is a template requiring reviewed bindings,
not a unit that the package installs or enables automatically. Do not run a
second monitor against the same state directory or mix supervisors.

Only the fixed public production modules, README and service template are copied
to `tools/ops`. Tests, crash fixtures, state files, private descriptors and other
directory additions are excluded. The package manifest covers the copied bytes.
The builder imports the packaged service/status dependency graph without starting
it; a successful import is not a service, incident-recovery or continuous-operation
acceptance result. Validate the complete source-bound artifact, private deployment
bindings, durable queue/recovery, real notification channel and applicable soak
before claiming installed M6 or 24x7 acceptance.
