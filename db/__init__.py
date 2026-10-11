"""
Storage backend factory for Buzzdrop.

``create_backend(DATABASE_URL)`` returns a :class:`db.base.Backend`
exposing ``.files`` (FileStore) and ``.tokens`` (TokenStore).

Supported schemes:

- ``sqlite:///path/to/file.db`` — the only implemented backend.

Future backends (``postgresql://``, ``mysql://``, ``oracle://``) plug in by
implementing FileStore/TokenStore over raw DB-API drivers, registering the
scheme here, and passing the contract suite in
``tests/contract/test_backend_contract.py``.
"""
from typing import Optional
from urllib.parse import urlparse

from db.base import Backend, FileStore, TokenStore
from db.sqlite_backend import SQLiteBackend

__all__ = ['Backend', 'FileStore', 'TokenStore', 'SQLiteBackend', 'create_backend']

_SQLITE_PREFIX = 'sqlite:///'


def create_backend(database_url: str,
                   legacy_timezone: Optional[str] = None,
                   legacy_expiry_timezone: Optional[str] = None) -> Backend:
    """
    Create a storage backend for the given DATABASE_URL.

    Args:
        database_url: e.g. ``sqlite:///buzzdrop.db``. A bare path with no
            scheme is treated as a SQLite file path for convenience.
        legacy_timezone: the zone naive timestamps written before #250 are
            read in when they are migrated to UTC (IANA name; unset: the
            host's zone). ``LEGACY_TIMESTAMP_TIMEZONE`` in the app config.
        legacy_expiry_timezone: the zone naive expiries typed by uploaders
            before #250 are read in. The app passes ``DEFAULT_TIMEZONE``.

    Returns:
        Backend with ``.files`` and ``.tokens`` stores.

    Raises:
        NotImplementedError: For schemes without an implemented backend.
    """
    if not database_url:
        raise ValueError('DATABASE_URL must not be empty')

    if database_url.startswith(_SQLITE_PREFIX):
        return SQLiteBackend(database_url[len(_SQLITE_PREFIX):], legacy_timezone,
                             legacy_expiry_timezone)
    if database_url in ('sqlite://', 'sqlite:'):
        raise ValueError(f'Invalid SQLite DATABASE_URL: {database_url!r}')

    scheme = urlparse(database_url).scheme
    if not scheme:
        # Bare path — treat as a SQLite file for convenience/back-compat.
        return SQLiteBackend(database_url, legacy_timezone,
                             legacy_expiry_timezone)

    raise NotImplementedError(
        f'DATABASE_URL scheme {scheme!r} is not supported yet. '
        'Only sqlite:/// is implemented; additional backends must implement '
        'FileStore and TokenStore and register in db.create_backend().'
    )
