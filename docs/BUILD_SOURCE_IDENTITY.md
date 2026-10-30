# Bundle build source identity

The native Linux bundle builder records an exact Git commit and tree, the dirty flag, SHA-256 for every selected source file, and each file's executable mode. The existing `files` map stays available in `source-manifest.json`; format 2 adds `tree` and `modes`. Its fingerprint covers the format, byte hashes and modes. The public bundle manifest also records the source tree.

The selected inventory remains Git's tracked plus nonignored untracked files. Generated ignored output does not become an input. Source symlinks are refused instead of silently skipped or followed into an unrecorded dependency. Missing, nonregular, replaced or observably changing files fail the capture. Reading uses a no-follow file descriptor and verifies the descriptor's actual path, file metadata and byte count.

After all build and copy steps, the builder captures source again and compares commit, tree, dirty state, fingerprint, file hashes and modes before sealing the artifact. A failure leaves a failed build input for reconciliation; it does not authorize retrying deployment, deleting shared files or changing the active release.

This is drift detection on the existing isolated build checkout. It is not an atomic filesystem snapshot or proof against a writer that changes and restores source between observations. Preserve the existing single-writer build input and independently bind its commit, tree, artifact hash, actual commands and runtime evidence. Format 1 historical source fingerprints remain historical; they are not silently relabeled as format 2.

The focused Linux regression source is `scripts/install/build-source-manifest.test.mjs`. It covers a clean capture, changed bytes on one commit, executable drift with Git file-mode tracking disabled, dirty-only drift, untracked input, ignored output, outside source links a replaced parent directory, and special filenames that must remain real manifest entries. Authored regressions do not count as executed results. This change does not install a service, change deployment parameters, rebuild an existing release or establish full-product acceptance.
