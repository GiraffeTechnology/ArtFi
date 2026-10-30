#!/usr/bin/env python3
"""Archive only this harness's stopped disposable TEST_ONLY MySQL data.
Every decompressed regular file is SHA256-checked before the raw duplicate is removed.
"""
from pathlib import Path
import hashlib
import json
import shutil
import sys
import tarfile

root = Path(sys.argv[1]).resolve()
if not root.name.startswith("artfi-stage2-mysql.") or (root / "mysql.pid").exists():
    raise SystemExit("STOPPED_ISOLATED_TEST_DIRECTORY_REQUIRED")
config = json.loads((root / "database.json").read_text())
if config.get("database") != "artfi_stage2_isolated_test" or config.get("host") != "127.0.0.1":
    raise SystemExit("ISOLATED_TEST_DATABASE_REQUIRED")
data = root / "data"
if not data.exists():
    raise SystemExit(0)
if data.is_symlink():
    raise SystemExit("ISOLATED_TEST_DATA_SYMLINK_REFUSED")

def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()

expected = {}
for file in data.rglob("*"):
    if file.is_symlink():
        raise SystemExit("ISOLATED_TEST_DATA_SYMLINK_REFUSED")
    if file.is_file():
        with file.open("rb") as stream:
            expected[str(file.relative_to(root))] = digest(stream)
archive = root / "stopped-test-data.tar.gz"
with tarfile.open(archive, "w:gz", compresslevel=5) as output:
    output.add(data, arcname="data")
observed = {}
with tarfile.open(archive, "r:gz") as saved:
    for member in saved:
        if member.isfile():
            with saved.extractfile(member) as stream:
                observed[member.name] = digest(stream)
if observed != expected:
    raise SystemExit("ARCHIVE_VERIFICATION_FAILED_RAW_RETAINED")
with archive.open("rb") as stream:
    archive_hash = digest(stream)
(root / "stopped-test-data.sha256.json").write_text(json.dumps({
    "mode": "TEST_ONLY_NO_REAL_VALUE", "files": expected,
    "archiveSha256": archive_hash, "verifiedDecompressedFiles": len(expected),
}, indent=2) + "\n")
shutil.rmtree(data)
print(f"TEST_ONLY_DATA_ARCHIVED files={len(expected)} archive={archive.name}")
