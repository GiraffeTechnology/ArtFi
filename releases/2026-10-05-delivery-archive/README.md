# ArtFi delivery archive inventory

This directory preserves the historical and candidate archives listed below. New GitHub-safe copies have explicit `-github-safe` filenames. Keep repository access private.

## Download and verify

Download the files listed in `manifest.json`, retaining their repository-relative layout. Run `sha256sum --check SHA256SUMS` from this directory to verify the newly published ZIP files. The checksum list uses their exact published names. Reconstructed full ZIPs have separate hashes in the manifest; they are not additional downloads.

The manifest distinguishes the original archive identity from the distributed GitHub-safe bytes. The two hashes must not be interchanged. Application source identity remains separate from the commit that publishes these archives.

## Archive versions

- [01-ArtFi-Wallet-Handoff-20261003.zip](01-ArtFi-Wallet-Handoff-20261003-github-safe.zip): historical
- [ArtFi-Coding-Handoff-13f9b6b7-20261003.zip](ArtFi-Coding-Handoff-13f9b6b7-20261003-github-safe.zip): historical
- [artfi-deployment-contract-20261003.zip](artfi-deployment-contract-20261003-github-safe.zip): historical
- [artfi-mint-vault-recovery-candidate-20261003.zip](artfi-mint-vault-recovery-candidate-20261003-github-safe.zip): historical
- [artfi-native-rebuilt-candidate-20261003.zip](artfi-native-rebuilt-candidate-20261003-github-safe.zip): historical
- [artfi-portfolio-read-models-20261003.zip](artfi-portfolio-read-models-20261003-github-safe.zip): historical

## Interpretation

Candidate and historical labels describe archive status only. This archive publication does not establish a release, deployment, current-head CI result or genuine-device acceptance, and it makes no application changes.

GitHub-safe copies include their applicable publication and omission notices. For their extracted contents, follow the current-copy checksum instructions included in each archive. References marked `HISTORICAL-REFERENCE` preserve provenance and are not current-copy verification commands.
