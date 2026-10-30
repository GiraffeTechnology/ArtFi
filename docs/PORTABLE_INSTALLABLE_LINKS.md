# Portable installable dependency links

The native Linux bundle builder validates its actual output tree before importing
the packaged agent module and again immediately before creating the archive.
Both checks are read-only. They do not install, start, stop or reload a service.

Each symbolic link must use a relative target, remain lexically inside the build
root and resolve through its complete link chain to an existing entry inside that
root. Absolute targets are refused even when they currently point inside the
artifact: they bind the package to a build host. Broken targets, cycles, control
characters, unsupported filesystem entry types and observable entry changes also
refuse the build. A linked root directory is refused rather than silently
substituting another output tree.

Ordinary package dependency and self-reference links inside the artifact remain
supported. The check never rewrites a link, resolves a new dependency version or
copies a target from outside the artifact. An invalid dependency layout must be
repaired by the original package producer and verified against its fixed source;
the builder does not fall back to host-installed dependencies.

The failure message omits link targets, resolved host paths and original operating
system error causes. This prevents a portability refusal from publishing a private
filesystem location. It does not assert that every other command's diagnostics
are private or that artifact content contains no secrets.

## Scope of the evidence

The guard detects observable changes in an isolated single-writer directory. It
does not provide an atomic filesystem snapshot or prevent a malicious concurrent
writer from changing the tree after the check. Keep the existing single-writer
build boundary, source identity checks, artifact hash inventory and independent
download verification. The guard does not clear the complete source tree, nested
archives, public configuration, credentials or deployed services for publication.

Six Node test declarations are authored for internal dependency/self links,
absolute internal targets, direct and intermediate escapes, broken links/cycles,
and non-existent or linked roots. Fixtures use only newly created synthetic task
directories and always remove their own scratch directory. They are unexecuted
source here. Run the affected tests, formatter and actual native installable
pipeline on the existing approved Linux runtime before acceptance. A source
handoff or a successful link check alone is not full product delivery.
