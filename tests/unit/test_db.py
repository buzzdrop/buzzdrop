import pytest
import os
import shutil # For file operations in cleanup test setup
from utils import cleanup_orphaned_files

from unittest import mock
# Fixtures 'app', 'db_instance', 'files_store' will be injected from conftest.py

def test_add_and_get_file_record(files_store):
    # files_store fixture ensures the table is empty at the start of the test
    assert len(files_store.all()) == 0

    file_data = {
        'id': 'uuid1',
        'original_name': 'test.txt',
        'path': '/fake/path/uuid1',
        'uploaded_by': 'testuser',
        'shared_with': []
    }
    files_store.insert(file_data)

    assert len(files_store.all()) == 1

    retrieved_file = files_store.get_by_id('uuid1')
    assert retrieved_file is not None
    assert retrieved_file['original_name'] == 'test.txt'
    assert retrieved_file['uploaded_by'] == 'testuser'

def test_get_non_existent_file_record(files_store):

    retrieved_file = files_store.get_by_id('nonexistent')
    assert retrieved_file is None

def test_cleanup_orphaned_files_no_orphans(app, files_store):
    # app fixture provides UPLOAD_FOLDER
    # files_store fixture provides the db table
    upload_dir = app.config['UPLOAD_FOLDER']

    # Clean the upload directory before the test to remove leftovers from other tests
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    # Create a dummy file on disk that IS tracked
    tracked_file_on_disk_path = os.path.join(upload_dir, "tracked_file.txt")
    with open(tracked_file_on_disk_path, "w") as f:
        f.write("content")

    files_store.insert({'id': '1', 'path': tracked_file_on_disk_path, 'original_name': 'tracked_file.txt'})

    # Get tracked files from database
    tracked_files = set(f['path'].split(os.sep)[-1] for f in files_store.all())

    with mock.patch('os.remove') as mock_remove:
        cleanup_orphaned_files(upload_dir, tracked_files)
        mock_remove.assert_not_called() # No files should be removed

    # Ensure the tracked file is still there (optional, os.remove is mocked)
    assert os.path.exists(tracked_file_on_disk_path)
    # Clean up the created file
    os.remove(tracked_file_on_disk_path)

def test_cleanup_orphaned_files_with_orphans(app, files_store):
    upload_dir = app.config['UPLOAD_FOLDER']

    # Clean the upload directory before the test
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    # File on disk, tracked in DB
    tracked_file_path = os.path.join(upload_dir, "tracked.txt")
    with open(tracked_file_path, "w") as f: f.write("tracked")
    files_store.insert({'id': 't1', 'path': tracked_file_path, 'original_name': 'tracked.txt'})

    # File on disk, NOT tracked in DB (orphan)
    orphaned_file_path = os.path.join(upload_dir, "orphaned.txt")
    with open(orphaned_file_path, "w") as f: f.write("orphan")

    # File in DB, NOT on disk (should be ignored by cleanup_orphaned_files)
    files_store.insert({'id': 'db_only', 'path': os.path.join(upload_dir, "db_only_missing_on_disk.txt"), 'original_name': 'db_only.txt'})

    # Get tracked files from database
    tracked_files = set(f['path'].split(os.sep)[-1] for f in files_store.all())

    # Mock os.remove to check it's called on the correct file
    # os.listdir and os.path.exists will operate on the actual temp test upload folder
    removed_paths = []
    original_os_remove = os.remove
    def mock_os_remove(path):
        removed_paths.append(path)
        original_os_remove(path) # actually remove for post-condition check

    with mock.patch('os.remove', side_effect=mock_os_remove) as mocked_remove:
        with app.app_context():
             cleanup_orphaned_files(upload_dir, tracked_files)

        # Assertions
        assert orphaned_file_path in removed_paths
        assert tracked_file_path not in removed_paths

        mocked_remove.assert_any_call(orphaned_file_path) # Check that os.remove was called with the orphan

        # Verify actual file system state
        assert os.path.exists(tracked_file_path)
        assert not os.path.exists(orphaned_file_path)

    # Cleanup
    if os.path.exists(tracked_file_path):
        os.remove(tracked_file_path)


def test_cleanup_orphaned_files_empty_uploads_dir(app, files_store):
    upload_dir = app.config['UPLOAD_FOLDER']
    # Clean the upload directory before the test (it should be empty for this test's purpose anyway)
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    files_store.insert({'id': 'db_only', 'path': os.path.join(upload_dir, "some_file_in_db.txt")})

    # Get tracked files from database
    tracked_files = set(f['path'].split(os.sep)[-1] for f in files_store.all())

    with mock.patch('os.remove') as mock_remove:
        cleanup_orphaned_files(upload_dir, tracked_files)
        mock_remove.assert_not_called()

def test_mark_downloaded_second_claim_fails(app, db_instance):
    """A sequential re-claim must be rejected once a file is downloaded."""
    from models import FileRepository
    repo = FileRepository()
    with app.app_context():
        file_id = repo.create({
            'original_name': 'claimed.txt',
            'path': '/fake/claimed',
            'uploaded_by': 'testuser',
        })
        assert repo.mark_downloaded(file_id, '1.2.3.4') is True
        assert repo.mark_downloaded(file_id, '5.6.7.8') is False

        info = repo.get_by_id(file_id)
        assert info['downloaded_at'] is not None
        assert info['downloaded_by_ip'] == '1.2.3.4'


def test_mark_downloaded_concurrent_claims_single_winner(app, db_instance):
    """Concurrent mark_downloaded calls must produce exactly one winner."""
    from concurrent.futures import ThreadPoolExecutor
    from models import FileRepository

    repo = FileRepository()
    with app.app_context():
        file_id = repo.create({
            'original_name': 'race.txt',
            'path': '/fake/race',
            'uploaded_by': 'testuser',
        })

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda index: repo.mark_downloaded(file_id, f'10.0.0.{index}'),
            range(workers),
        ))

    assert results.count(True) == 1

    info = repo.get_by_id(file_id)
    assert info['downloaded_at'] is not None
    assert info['downloaded_by_ip'] in {f'10.0.0.{i}' for i in range(workers)}


def test_cleanup_orphaned_files_uploads_dir_does_not_exist(app, files_store):
    # This test needs to temporarily remove the upload directory.
    upload_dir = app.config['UPLOAD_FOLDER']
    original_upload_dir_path = upload_dir

    # Temporarily "remove" the directory by renaming it, or ensure it's gone
    # For this test, cleanup_orphaned_files itself checks os.path.exists(upload_dir)
    # So, we can mock os.path.exists for the upload_dir path to return False.

    with mock.patch('os.path.exists') as mock_path_exists, \
         mock.patch('os.listdir') as mock_listdir, \
         mock.patch('os.remove') as mock_remove:

        # Make os.path.exists return False only for the specific upload_dir path
        def side_effect_exists(path):
            if path == upload_dir:
                return False
            return os.path.exists(path) # Call original for other paths
        mock_path_exists.side_effect = side_effect_exists

        # Get tracked files from database  
        tracked_files = set(f['path'].split(os.sep)[-1] for f in files_store.all())

        cleanup_orphaned_files(upload_dir, tracked_files)

        mock_listdir.assert_not_called() # Should not attempt to listdir if path doesn't exist
        mock_remove.assert_not_called() # No removal attempts


# --- schema evolution: opening a backend on a stale database --------

def _legacy_doc_blob_db(path):
    """Create a database in the original doc-blob shape (doc TEXT NOT NULL)."""
    import sqlite3
    import json
    conn = sqlite3.connect(path)
    conn.execute(
        'CREATE TABLE files (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, '
        'doc TEXT NOT NULL)')
    conn.execute(
        'CREATE TABLE api_tokens (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, '
        'doc TEXT NOT NULL)')
    conn.execute('INSERT INTO files (doc) VALUES (?)', (json.dumps({
        'id': 'legacy-1', 'original_name': 'old.txt', 'status': 'active',
        'notify_on_open': True, 'unknown_field': 'kept-in-extra',
    }),))
    conn.execute('INSERT INTO api_tokens (doc) VALUES (?)', (json.dumps({
        'token_hash': 'th-1', 'username': 'legacyuser',
    }),))
    conn.commit()
    conn.close()


def test_legacy_doc_blob_tables_are_rebuilt(tmp_path):
    """A doc-blob schema DB must be rebuilt with data and doc_ids preserved."""
    import sqlite3
    from db.sqlite_backend import SQLiteBackend

    path = tmp_path / 'legacy.db'
    _legacy_doc_blob_db(str(path))

    backend = SQLiteBackend(str(path))
    try:
        doc = backend.files.get_by_id('legacy-1')
        assert doc is not None
        assert doc['doc_id'] == 1                     # doc_id preserved
        assert doc['original_name'] == 'old.txt'
        assert doc['notify_on_open'] is True          # bool round-trip
        assert doc['unknown_field'] == 'kept-in-extra'  # extra overflow

        token = backend.tokens.get_by_token_hash('th-1')
        assert token is not None and token['doc_id'] == 1

        # the failure mode the rebuild exists for: inserts must work
        assert backend.files.insert({'id': 'new-1'}) == 2

        cols = {r[1] for r in sqlite3.connect(str(path)).execute(
            'PRAGMA table_info(files)')}
        assert 'doc' not in cols
        assert 'notification_claimed_at' in cols
    finally:
        backend.close()


def test_missing_columns_added_to_existing_table(tmp_path):
    """A table missing recently-added columns gets them via ALTER TABLE."""
    import sqlite3
    from db.sqlite_backend import SQLiteBackend

    path = tmp_path / 'older.db'
    conn = sqlite3.connect(str(path))
    conn.execute(
        'CREATE TABLE files (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, '
        'id TEXT UNIQUE, original_name TEXT, extra TEXT)')
    conn.execute(
        'CREATE TABLE api_tokens '
        '(doc_id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT)')
    conn.commit()
    conn.close()

    backend = SQLiteBackend(str(path))
    try:
        cols = {r[1] for r in sqlite3.connect(str(path)).execute(
            'PRAGMA table_info(files)')}
        assert 'notification_claimed_at' in cols
        # insert using the previously-missing column must not fail
        assert backend.files.insert(
            {'id': 'x', 'notification_claimed_at': None}) == 1
    finally:
        backend.close()


def test_incompatible_not_null_column_fails_fast(tmp_path):
    """An unexpected NOT NULL column must raise a clear error, not a
    cryptic IntegrityError on first insert."""
    import sqlite3
    from db.sqlite_backend import SQLiteBackend

    path = tmp_path / 'weird.db'
    conn = sqlite3.connect(str(path))
    conn.execute(
        'CREATE TABLE files (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, '
        'id TEXT UNIQUE, mystery TEXT NOT NULL)')
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.DatabaseError, match='mystery'):
        SQLiteBackend(str(path))


def _pre_250_db(path):
    """A database written before #250: every time naive, in the host's
    wall-clock time, and an expiry kept with the uploader's offset."""
    from db.sqlite_backend import SQLiteBackend

    backend = SQLiteBackend(path)
    backend.files.insert({
        'id': 'old-drop', 'created_at': '2026-10-08T21:00:00.123456',
        'downloaded_at': '2026-10-08T22:00:00', 'expiry_at': '2026-10-09T21:00:00+02:00',
        'notification_sent_at': '2026-10-08T22:00:01', 'notification_claimed_at': 'not a time',
    })
    backend.files.create_key_share('old-drop', 'aa' * 32, created_at='2026-10-08T20:59:00')
    backend.files.insert({'id': 'new-drop', 'created_at': '2026-10-08T19:00:00.000000+00:00'})
    # The expiry field sent the uploader's own wall-clock time, no zone.
    backend.files.insert({'id': 'typed-expiry', 'created_at': '2026-10-08T21:00:00',
                          'expiry_at': '2026-10-09T21:00'})
    backend.tokens.insert({
        'token_hash': 'th-old', 'created_at': '2026-10-01T09:00:00',
        'last_used_at': None, 'expires_at': '2026-10-31T09:00:00',
    })
    backend.close()


def test_naive_timestamps_are_migrated_to_utc_in_the_legacy_zone(tmp_path):
    """#250: a Passenger host on Warsaw time wrote 21:00 meaning 19:00 UTC."""
    import sqlite3
    from db.sqlite_backend import SQLiteBackend

    path = str(tmp_path / 'pre-250.db')
    _pre_250_db(path)

    backend = SQLiteBackend(path, legacy_timezone='Europe/Warsaw')
    try:
        drop = backend.files.get_by_id('old-drop')
        assert drop['created_at'] == '2026-10-08T19:00:00.123456+00:00'
        assert drop['downloaded_at'] == '2026-10-08T20:00:00.000000+00:00'
        assert drop['expiry_at'] == '2026-10-09T19:00:00.000000+00:00'
        assert drop['notification_sent_at'] == '2026-10-08T20:00:01.000000+00:00'
        # Not a timestamp: left for the fail-closed checks to judge.
        assert drop['notification_claimed_at'] == 'not a time'
        assert backend.files.get_key_share('old-drop')['created_at'] \
            == '2026-10-08T18:59:00.000000+00:00'
        assert backend.files.get_by_id('new-drop')['created_at'] \
            == '2026-10-08T19:00:00.000000+00:00'
        token = backend.tokens.get_by_token_hash('th-old')
        assert token['created_at'] == '2026-10-01T07:00:00.000000+00:00'
        assert token['last_used_at'] is None
        assert token['expires_at'] == '2026-10-31T08:00:00.000000+00:00'  # CET by then
    finally:
        backend.close()

    # Once migrated, opening the database again changes nothing, whatever
    # zone it is opened with.
    before = sqlite3.connect(path).execute('SELECT created_at FROM files ORDER BY doc_id').fetchall()
    SQLiteBackend(path, legacy_timezone='Asia/Tokyo').close()
    after = sqlite3.connect(path).execute('SELECT created_at FROM files ORDER BY doc_id').fetchall()
    assert after == before


def test_naive_timestamps_default_to_the_host_zone(tmp_path):
    """No setting: the zone the host is on now (New York in this suite),
    which is right for a host whose zone never changed."""
    from db.sqlite_backend import SQLiteBackend

    path = str(tmp_path / 'pre-250.db')
    _pre_250_db(path)

    backend = SQLiteBackend(path)
    try:
        assert backend.files.get_by_id('old-drop')['created_at'] \
            == '2026-10-09T01:00:00.123456+00:00'
    finally:
        backend.close()


def test_an_unknown_legacy_zone_stops_the_app(tmp_path):
    from db.sqlite_backend import SQLiteBackend

    with pytest.raises(ValueError, match='LEGACY_TIMESTAMP_TIMEZONE'):
        SQLiteBackend(str(tmp_path / 'x.db'), legacy_timezone='Mars/Olympus')


def test_a_naive_expiry_is_read_in_the_uploaders_zone_not_the_hosts(tmp_path):
    """Before #250 the expiry field stored what the uploader typed, in
    their own zone: on a UTC Docker host that is not the host's zone. It is
    read in legacy_expiry_timezone (the app passes DEFAULT_TIMEZONE)."""
    from db.sqlite_backend import SQLiteBackend

    path = str(tmp_path / 'pre-250.db')
    _pre_250_db(path)

    backend = SQLiteBackend(path, legacy_timezone='UTC',
                            legacy_expiry_timezone='Europe/Warsaw')
    try:
        drop = backend.files.get_by_id('typed-expiry')
        assert drop['created_at'] == '2026-10-08T21:00:00.000000+00:00'
        assert drop['expiry_at'] == '2026-10-09T19:00:00.000000+00:00'
    finally:
        backend.close()
