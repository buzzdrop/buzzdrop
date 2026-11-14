#!/usr/bin/env python3
"""
Manual orphan-blob sweep (docs/known-issues.md).

Deletes storage blobs that no `files` or `dropzone_submissions` row
references — the residue of a claim/delete race or a silently failed
storage delete. Works for the local and the S3 backend.

Usage (from the repo root, with the app's environment):

    python cleanup_orphans.py            # report and delete
    python cleanup_orphans.py --dry-run  # report only

Best run with the app stopped. As a safety net the sweep skips blobs
younger than KEY_SHARE_PENDING_TTL_SECONDS, so a two-phase upload still
in flight is never mistaken for an orphan.
"""
import os
import sys
import time

from config import get_config
from db import create_backend
from storage import get_storage_backend


def _basename(path: str) -> str:
    return path.replace('\\', '/').rstrip('/').split('/')[-1]


def _tracked_names(files_store) -> set:
    names = {_basename(f['path']) for f in files_store.all() if f.get('path')}
    names.update(
        _basename(sub['path'])
        for sub in files_store.list_dropzone_submissions()
        if sub.get('path'))
    return names


def _list_blobs(storage, config) -> dict:
    """{storage path: age in seconds} for every blob under the upload area."""
    now = time.time()
    if storage.backend_type == 's3':
        blobs = {}
        paginator = storage.client.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=storage.bucket, Prefix='uploads/'):
            for obj in page.get('Contents', []):
                blobs[obj['Key']] = now - obj['LastModified'].timestamp()
        return blobs
    folder = config.UPLOAD_FOLDER
    if not os.path.isdir(folder):
        return {}
    blobs = {}
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        try:
            blobs[path] = now - os.path.getmtime(path)
        except OSError:
            continue
    return blobs


def main() -> int:
    dry_run = '--dry-run' in sys.argv
    config = get_config()
    files_store = create_backend(config.get_database_url()).files
    storage = get_storage_backend(config)
    tracked = _tracked_names(files_store)
    min_age = config.KEY_SHARE_PENDING_TTL_SECONDS

    removed = skipped = failed = 0
    for path, age in sorted(_list_blobs(storage, config).items()):
        if _basename(path) in tracked:
            continue
        if age < min_age:
            print(f'skip (in-flight window, {int(age)}s old): {path}')
            skipped += 1
            continue
        if dry_run:
            print(f'would remove: {path}')
            removed += 1
            continue
        try:
            storage.delete(path)
        except Exception as exc:
            print(f'FAILED to remove {path}: {exc}', file=sys.stderr)
            failed += 1
            continue
        # storage.delete swallows backend errors (#465) — verify.
        try:
            still_there = storage.exists(path)
        except Exception:
            still_there = False
        if still_there:
            print(f'FAILED to remove {path}: delete reported success but the blob is still there',
                  file=sys.stderr)
            failed += 1
        else:
            print(f'removed: {path}')
            removed += 1

    verb = 'would remove' if dry_run else 'removed'
    print(f'\n{verb}: {removed}, skipped (young): {skipped}, failed: {failed}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
