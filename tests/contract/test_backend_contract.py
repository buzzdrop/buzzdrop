"""
Backend contract test suite.

This suite is the acceptance bar for every storage backend. It runs
against SQLite always; additional backends activate by exporting a DSN:

    BUZZDROP_TEST_PG_DSN=postgresql://user:pass@host/db
    BUZZDROP_TEST_MYSQL_DSN=mysql://user:pass@host/db
    BUZZDROP_TEST_ORACLE_DSN=oracle://user:pass@host/service

To add a backend: implement FileStore + TokenStore (db/base.py), register
the scheme in db.create_backend(), and make this suite pass.
"""
import hashlib
import hmac
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from timestamps import now_iso, to_utc_iso, utcnow

import pytest

from db import create_backend

_EXTRA_DSNS = (
    ('postgresql', 'BUZZDROP_TEST_PG_DSN'),
    ('mysql', 'BUZZDROP_TEST_MYSQL_DSN'),
    ('oracle', 'BUZZDROP_TEST_ORACLE_DSN'),
)


def _backend_params():
    params = [pytest.param('sqlite', id='sqlite')]
    for name, env_var in _EXTRA_DSNS:
        if os.getenv(env_var):
            params.append(pytest.param(env_var, id=name))
    return params


@pytest.fixture(params=_backend_params())
def backend(request, tmp_path):
    """Yield a fresh, empty Backend for each configured DSN."""
    if request.param == 'sqlite':
        url = f'sqlite:///{tmp_path}/contract.db'
    else:
        url = os.environ[request.param]
        # External backends need their tables truncated between tests.
        backend = create_backend(url)
        backend.files.truncate()
        backend.tokens.truncate()
        yield backend
        backend.close()
        return

    backend = create_backend(url)
    yield backend
    backend.close()


def _file_doc(file_id='file-1', **overrides):
    doc = {
        'id': file_id,
        'original_name': 'secret.txt',
        'path': f'uploads/{file_id}',
        'created_at': now_iso(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': None,
        'status': 'active',
        'decryption_success': None,
        'type': 'file',
        'shared_with': ['alice', 'bob'],
        'notify_on_open': True,
        'custom_field': 'stashed-in-extra',
    }
    doc.update(overrides)
    return doc


# ---------------------------------------------------------------------------
# FileStore contract
# ---------------------------------------------------------------------------

def test_insert_and_get_by_id_roundtrip(backend):
    doc_id = backend.files.insert(_file_doc())
    assert isinstance(doc_id, int)

    stored = backend.files.get_by_id('file-1')
    assert stored is not None
    assert stored['doc_id'] == doc_id
    assert stored['original_name'] == 'secret.txt'
    assert stored['downloaded_at'] is None
    # bool and list values round-trip exactly
    assert stored['notify_on_open'] is True
    assert stored['decryption_success'] is None
    assert stored['shared_with'] == ['alice', 'bob']
    # unknown fields survive via the overflow column
    assert stored['custom_field'] == 'stashed-in-extra'


def test_get_by_id_missing(backend):
    assert backend.files.get_by_id('nope') is None


def test_insert_with_explicit_doc_id(backend):
    """Explicit doc_id round-trips and auto ids keep increasing past it."""
    doc_id = backend.files.insert(_file_doc(), doc_id=100)
    assert doc_id == 100
    assert backend.files.get_by_id('file-1')['doc_id'] == 100

    next_id = backend.files.insert(_file_doc('file-2'))
    assert next_id > 100


def test_get_by_and_list_by(backend):
    backend.files.insert(_file_doc('a', uploaded_by='u1', status='active'))
    backend.files.insert(_file_doc('b', uploaded_by='u1', status='expired'))
    backend.files.insert(_file_doc('c', uploaded_by='u2', status='active'))

    assert backend.files.get_by(original_name='secret.txt',
                                uploaded_by='u1')['id'] == 'a'
    assert [f['id'] for f in backend.files.list_by(uploaded_by='u1')] == ['a', 'b']
    assert [f['id'] for f in backend.files.list_by(status='active')] == ['a', 'c']
    assert backend.files.list_by(uploaded_by='nobody') == []


def test_all_returns_every_record(backend):
    backend.files.insert(_file_doc('x'))
    backend.files.insert(_file_doc('y'))
    assert sorted(f['id'] for f in backend.files.all()) == ['x', 'y']


def test_update_fields(backend):
    backend.files.insert(_file_doc())
    assert backend.files.update_fields('file-1', {
        'status': 'expired',
        'decryption_success': False,
        'another_extra': 42,
    }) is True

    stored = backend.files.get_by_id('file-1')
    assert stored['status'] == 'expired'
    assert stored['decryption_success'] is False
    assert stored['another_extra'] == 42
    # untouched fields preserved
    assert stored['original_name'] == 'secret.txt'


def test_update_fields_missing_id(backend):
    assert backend.files.update_fields('nope', {'status': 'x'}) is False


def test_claim_notification_send_once(backend):
    backend.files.insert(_file_doc())
    assert backend.files.claim_notification_send('file-1') is True
    assert backend.files.claim_notification_send('file-1') is False


def test_claim_notification_send_rejects_sent(backend):
    backend.files.insert(_file_doc())
    backend.files.update_fields(
        'file-1', {'notification_sent_at': now_iso()}
    )
    assert backend.files.claim_notification_send('file-1') is False


def test_delete(backend):
    backend.files.insert(_file_doc())
    assert backend.files.delete('file-1') is True
    assert backend.files.get_by_id('file-1') is None
    assert backend.files.delete('file-1') is False


def test_files_truncate(backend):
    backend.files.insert(_file_doc())
    backend.files.truncate()
    assert backend.files.all() == []


# ---------------------------------------------------------------------------
# FileStore contract — server-gated key release
# ---------------------------------------------------------------------------

_H = 'aa' * 32
_V = 'bb' * 32


def _bound_share(backend, file_id='f1', h=_H, v=_V, **doc_overrides):
    """A share bound to a real files row — the post-finish state."""
    backend.files.insert(_file_doc(file_id, **doc_overrides))
    backend.files.create_key_share(file_id, h, created_by='testuser')
    backend.files.bind_key_verifier(file_id, v)


def test_key_share_lifecycle(backend):
    assert backend.files.create_key_share(
        'f1', _H, created_by='testuser') is True
    # duplicate share for the same file_id is refused
    assert backend.files.create_key_share('f1', _H) is False

    share = backend.files.get_key_share('f1')
    assert share is not None
    assert share['file_id'] == 'f1'
    assert share['h'] == _H
    assert share['v'] is None
    assert share['attempts'] == 0
    assert share['released_at'] is None
    assert share['created_at'] is not None
    assert share['created_by'] == 'testuser'

    assert backend.files.bind_key_verifier('f1', _V) is True
    # second bind is refused — the verifier is set at upload finish, once
    assert backend.files.bind_key_verifier('f1', 'cc' * 32) is False
    assert backend.files.get_key_share('f1')['v'] == _V


def test_bind_key_verifier_stores_salt(backend):
    """The envelope salt rides on the share so /view can hand it to the
    client before it proves the password."""
    backend.files.insert(_file_doc())
    backend.files.create_key_share('file-1', _H, created_by='testuser')
    assert backend.files.bind_key_verifier('file-1', _V, 'aa' * 16) is True
    assert backend.files.get_key_share('file-1')['salt'] == 'aa' * 16


def _download_ticket(h_hex):
    """The ticket a client derives from H — HKDF-SHA256, zero salt,
    info='buzzdrop-download-ticket'. Kept independent of the backend's
    derivation so a divergence shows here."""
    prk = hmac.new(b'\x00' * 32, bytes.fromhex(h_hex), hashlib.sha256).digest()
    return hmac.new(prk, b'buzzdrop-download-ticket' + b'\x01',
                    hashlib.sha256).hexdigest()


def test_release_mints_download_ticket(backend):
    """A winning release stores only the digest of the ticket the client
    derives from H."""
    _bound_share(backend)

    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'ok'
    assert 'download_ticket' not in result

    share = backend.files.get_key_share('f1')
    assert share['ticket_hash'] == hashlib.sha256(
        bytes.fromhex(_download_ticket(_H))).hexdigest()


def test_claim_download_with_ticket(backend):
    _bound_share(backend)

    # Nothing to claim before a release — nobody holds a ticket.
    result = backend.files.claim_download_with_ticket('f1', 'ee' * 32, '1.2.3.4')
    assert result['status'] == 'not_released'
    assert backend.files.get_by_id('f1')['downloaded_at'] is None

    assert backend.files.attempt_key_release('f1', _V, 3, False)['status'] == 'ok'
    ticket = _download_ticket(_H)

    # A wrong ticket doesn't claim — and doesn't consume the real one.
    result = backend.files.claim_download_with_ticket('f1', 'ee' * 32, '1.2.3.4')
    assert result['status'] == 'bad_ticket'
    assert backend.files.get_by_id('f1')['downloaded_at'] is None
    result = backend.files.claim_download_with_ticket('f1', None, '1.2.3.4')
    assert result['status'] == 'bad_ticket'

    result = backend.files.claim_download_with_ticket('f1', ticket, '1.2.3.4')
    assert result['status'] == 'ok'
    stored = backend.files.get_by_id('f1')
    assert stored['downloaded_at'] is not None
    assert stored['downloaded_by_ip'] == '1.2.3.4'
    # The claim consumed the ticket digest.
    assert backend.files.get_key_share('f1')['ticket_hash'] is None

    result = backend.files.claim_download_with_ticket('f1', ticket, '5.6.7.8')
    assert result['status'] == 'already_downloaded'


def test_claim_download_with_ticket_concurrent_single_winner(backend):
    """≥8 racing ticketed claims must produce exactly one winner."""
    _bound_share(backend)
    backend.files.attempt_key_release('f1', _V, 3, False)
    ticket = _download_ticket(_H)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda index: backend.files.claim_download_with_ticket(
                'f1', ticket, f'10.0.0.{index}')['status'],
            range(workers),
        ))

    assert results.count('ok') == 1
    assert results.count('already_downloaded') == workers - 1


def test_claim_download_with_ticket_honours_the_download_window(backend):
    """Inside the window the ticket claims; once it has closed the drop
    expires in the claim's transaction, share row and all."""
    _bound_share(backend, 'fresh')
    backend.files.attempt_key_release('fresh', _V, 3, False)
    assert backend.files.claim_download_with_ticket(
        'fresh', _download_ticket(_H), '1.2.3.4', 3600)['status'] == 'ok'

    _bound_share(backend, 'stale')
    backend.files.attempt_key_release('stale', _V, 3, False)
    result = backend.files.claim_download_with_ticket(
        'stale', _download_ticket(_H), '1.2.3.4', 0)
    assert result == {'status': 'expired', 'path': 'uploads/stale'}
    stored = backend.files.get_by_id('stale')
    assert stored['status'] == 'expired'
    assert stored['downloaded_at'] is None
    assert backend.files.get_key_share('stale') is None


def test_expire_unclaimed_releases(backend):
    """Only released, never-downloaded drops past the window expire."""
    _bound_share(backend, 'unclaimed')
    backend.files.attempt_key_release('unclaimed', _V, 3, False)
    _bound_share(backend, 'downloaded')
    backend.files.attempt_key_release('downloaded', _V, 3, False)
    backend.files.claim_download_with_ticket(
        'downloaded', _download_ticket(_H), '1.2.3.4')
    _bound_share(backend, 'unreleased')

    # Inside the window nothing is touched.
    assert backend.files.expire_unclaimed_releases(3600) == []
    assert backend.files.get_key_share('unclaimed') is not None

    expired = backend.files.expire_unclaimed_releases(0)
    assert expired == [{'id': 'unclaimed', 'path': 'uploads/unclaimed'}]
    assert backend.files.get_by_id('unclaimed')['status'] == 'expired'
    assert backend.files.get_key_share('unclaimed') is None
    assert backend.files.get_by_id('downloaded')['status'] == 'active'
    assert backend.files.get_by_id('unreleased')['status'] == 'active'
    assert backend.files.get_key_share('unreleased') is not None

    # Idempotent: a second pass finds nothing left.
    assert backend.files.expire_unclaimed_releases(0) == []


def test_claim_download_with_ticket_missing(backend):
    assert backend.files.claim_download_with_ticket(
        'nope', 'ee' * 32, '1.2.3.4')['status'] == 'missing'


def test_key_share_get_missing(backend):
    assert backend.files.get_key_share('nope') is None
    assert backend.files.delete_key_share('nope') is False
    assert backend.files.burn_key_share('nope') is False


def test_attempt_key_release_statuses(backend):
    """Each attempt runs as one transaction and answers a status."""
    _bound_share(backend)

    # verifier miss → denied, attempts counted inside the attempt
    result = backend.files.attempt_key_release('f1', 'dd' * 32, 3, False)
    assert result['status'] == 'denied'
    assert result['attempts'] == 1
    assert result['attempts_remaining'] == 2
    assert backend.files.get_key_share('f1')['attempts'] == 1

    # correct verifier releases H exactly once — and wipes h/v with the
    # claim, so a post-release DB theft yields no crackable material
    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'ok'
    assert result['h'] == _H
    released = backend.files.get_key_share('f1')
    assert released['released_at'] is not None
    assert released['h'] is None and released['v'] is None

    # post-release attempts are refused — even with the right V
    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'released'
    result = backend.files.attempt_key_release('f1', 'dd' * 32, 3, False)
    assert result['status'] == 'released'


def test_attempt_key_release_pending_and_missing(backend):
    backend.files.insert(_file_doc('f1'))
    backend.files.create_key_share('f1', _H)
    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'pending'
    # attempts are NOT counted against a pending share
    assert backend.files.get_key_share('f1')['attempts'] == 0

    # file exists but the share is gone (burned/deleted)
    backend.files.delete_key_share('f1')
    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'missing_share'

    # no file at all
    result = backend.files.attempt_key_release('ghost', _V, 3, False)
    assert result['status'] == 'missing_file'


def test_attempt_key_release_lockout(backend):
    """Exhausting attempts locks the share; burn optionally deletes it."""
    _bound_share(backend)
    # max=1: the first miss is already the lockout event
    result = backend.files.attempt_key_release('f1', 'dd' * 32, 1, False)
    assert result['status'] == 'locked'
    # lockout without burn keeps H — availability lost, not the share row
    assert backend.files.get_key_share('f1')['attempts'] == 1
    # lockout is terminal "never decrypted" — recorded on the files row
    assert backend.files.get_by_id('f1')['decryption_success'] is False
    # even the correct verifier is refused after lockout
    result = backend.files.attempt_key_release('f1', _V, 1, False)
    assert result['status'] == 'locked'
    assert backend.files.get_key_share('f1') is not None


def test_attempt_key_release_lockout_preserves_report(backend):
    """A prior receipt-backed report must not be clobbered by lockout."""
    _bound_share(backend)
    backend.files.record_decryption_result('f1', True)
    result = backend.files.attempt_key_release('f1', 'dd' * 32, 1, False)
    assert result['status'] == 'locked'
    assert backend.files.get_by_id('f1')['decryption_success'] is True


def test_attempt_key_release_burn_on_lockout(backend):
    _bound_share(backend)
    result = backend.files.attempt_key_release('f1', 'dd' * 32, 1, True)
    assert result['status'] == 'locked'
    # burned: H is gone for good, the ciphertext is mathematically dead
    assert backend.files.get_key_share('f1') is None
    result = backend.files.attempt_key_release('f1', _V, 1, True)
    assert result['status'] == 'missing_share'


def test_attempt_key_release_expired(backend):
    """Expiry is decided inside the same transaction — and destroys H."""
    past = to_utc_iso(utcnow() - timedelta(minutes=5))
    _bound_share(backend, expiry_at=past)

    result = backend.files.attempt_key_release('f1', _V, 3, False)
    assert result['status'] == 'expired'
    assert result['path'] == 'uploads/f1'
    assert backend.files.get_by_id('f1')['status'] == 'expired'
    # an expired share is dead — the row (and H) is gone
    assert backend.files.get_key_share('f1') is None


def test_attempt_key_release_concurrent_single_winner(backend):
    """≥8 racing releases must produce exactly one H — the key-release guarantee."""
    _bound_share(backend)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda _i: backend.files.attempt_key_release('f1', _V, 8, False),
            range(workers),
        ))

    assert [r['status'] for r in results].count('ok') == 1
    assert [r['status'] for r in results].count('released') == workers - 1
    assert backend.files.get_key_share('f1')['released_at'] is not None


def test_attempt_key_release_mixed_race(backend):
    """
    The atomic-attempt regression: racing requests must NOT all pass a
    shared read gate. One correct V among misses still yields exactly
    one 'ok', and the attempts counter equals the denied count —
    never inflated by losers racing the winner.
    """
    _bound_share(backend)

    verifiers = [_V] * 4 + ['ee' * 32] * 4
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(
            lambda v: backend.files.attempt_key_release('f1', v, 8, False),
            verifiers,
        ))

    statuses = [r['status'] for r in results]
    assert statuses.count('ok') == 1
    # whatever didn't win either got counted as a miss or saw the release
    assert set(statuses) <= {'ok', 'denied', 'released'}
    denied = statuses.count('denied')
    assert backend.files.get_key_share('f1')['attempts'] == denied


def test_attempt_key_release_race_never_exceeds_max(backend):
    """max=1 + 8 concurrent misses: the counter stops at 1, all locked."""
    _bound_share(backend)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda _i: backend.files.attempt_key_release(
                'f1', 'ee' * 32, 1, False),
            range(workers),
        ))

    assert [r['status'] for r in results] == ['locked'] * workers
    assert backend.files.get_key_share('f1')['attempts'] == 1


def test_purge_stale_key_shares(backend):
    """Pending shares past the TTL are swept; bound shares are not."""
    old = to_utc_iso(utcnow() - timedelta(hours=2))
    backend.files.create_key_share('old-pending', _H, created_at=old)
    backend.files.create_key_share('fresh-pending', 'cc' * 32)
    # A bound share is not pending even if its row is old.
    backend.files.insert(_file_doc('bound'))
    backend.files.create_key_share('bound', 'dd' * 32, created_at=old)
    backend.files.bind_key_verifier('bound', _V)
    # Malformed created_at counts as stale — fail closed.
    backend.files.create_key_share('broken', 'ee' * 32, created_at='junk')

    removed = backend.files.purge_stale_key_shares(3600)
    assert removed == 2
    assert backend.files.get_key_share('old-pending') is None
    assert backend.files.get_key_share('broken') is None
    assert backend.files.get_key_share('fresh-pending') is not None
    assert backend.files.get_key_share('bound') is not None


def test_record_decryption_result_first_write_wins(backend):
    """The NULL-guarded conditional write — racing reports resolve to one."""
    backend.files.insert(_file_doc())
    assert backend.files.record_decryption_result('file-1', True) is True
    assert backend.files.record_decryption_result('file-1', False) is False
    assert backend.files.get_by_id('file-1')['decryption_success'] is True
    assert backend.files.record_decryption_result('nope', True) is False


def test_delete_key_share(backend):
    backend.files.create_key_share('f1', _H)
    assert backend.files.delete_key_share('f1') is True
    assert backend.files.get_key_share('f1') is None
    # burned share is gone for good — no bind can resurrect H
    assert backend.files.bind_key_verifier('f1', _V) is False


def test_truncate_clears_key_shares(backend):
    backend.files.create_key_share('f1', _H)
    backend.files.truncate()
    assert backend.files.get_key_share('f1') is None


# ---------------------------------------------------------------------------
# FileStore contract — dropzones (the reversed one-shot flow, docs/adr/0001)
# ---------------------------------------------------------------------------

_DZ_SALT = 'aa' * 16
_DZ_WS = 'bb' * 32
_DZ_V = 'cc' * 32
_DZ_SV = 'dd' * 32
_DZ_WK = 'ee' * 32
_DZ_RECEIPT_HASH = 'ff' * 32
_WRONG_SV = '11' * 32
_WRONG_V = '22' * 32


def _dropzone_doc(dropzone_id='dz-1', **overrides):
    doc = {
        'id': dropzone_id,
        'salt': _DZ_SALT,
        'ws': _DZ_WS,
        'v': _DZ_V,
        'sv': _DZ_SV,
        'attempts': 0,
        'expiry_at': None,
        'created_at': now_iso(),
        'created_by': 'testuser',
        'link_consumed_at': None,
        'released_at': None,
        'collected_at': None,
        'collected_by_ip': None,
        'status': 'active',
        'notify_on_submission': False,
        'notification_email': None,
        'language': 'en',
        'memo': None,
    }
    doc.update(overrides)
    return doc


def _submission_doc(dropzone_id='dz-1', **overrides):
    doc = {
        'id': f'sub-{dropzone_id}',
        'dropzone_id': dropzone_id,
        'path': f'uploads/sub-{dropzone_id}',
        'type': 'file',
        'wk': _DZ_WK,
        'receipt_hash': _DZ_RECEIPT_HASH,
        'created_at': now_iso(),
    }
    doc.update(overrides)
    return doc


def _zone(backend, dropzone_id='dz-1', **overrides):
    """A live dropzone row, as POST /api/dropzones leaves it."""
    assert backend.files.create_dropzone(
        _dropzone_doc(dropzone_id, **overrides)) is True
    return dropzone_id


def _consumed_zone(backend, dropzone_id='dz-1', **zone_overrides):
    """A dropzone whose request link was spent on one submission."""
    _zone(backend, dropzone_id, **zone_overrides)
    result = backend.files.consume_for_submission(
        dropzone_id, _DZ_SV, _submission_doc(dropzone_id))
    assert result['status'] == 'ok'
    return dropzone_id


def _released_zone(backend, dropzone_id='dz-1', **zone_overrides):
    """A dropzone with a submission, released by the winning verifier."""
    _consumed_zone(backend, dropzone_id, **zone_overrides)
    result = backend.files.attempt_dropzone_release(dropzone_id, _DZ_V, 3, False)
    assert result['status'] == 'ok'
    return dropzone_id


def test_create_and_get_dropzone(backend):
    assert backend.files.create_dropzone(_dropzone_doc(
        custom_field='stashed-in-extra')) is True
    # a second zone with the same id is refused
    assert backend.files.create_dropzone(_dropzone_doc()) is False

    zone = backend.files.get_dropzone('dz-1')
    assert zone is not None
    assert zone['id'] == 'dz-1'
    assert zone['salt'] == _DZ_SALT
    assert zone['ws'] == _DZ_WS
    assert zone['v'] == _DZ_V
    assert zone['sv'] == _DZ_SV
    assert zone['attempts'] == 0
    assert zone['status'] == 'active'
    assert zone['created_by'] == 'testuser'
    assert zone['link_consumed_at'] is None
    assert zone['released_at'] is None
    assert zone['collected_at'] is None
    # unknown fields survive via the overflow column
    assert zone['custom_field'] == 'stashed-in-extra'
    assert backend.files.get_dropzone('nope') is None


def test_list_dropzones_is_scoped_to_the_requester(backend):
    _zone(backend, 'dz-1')
    _zone(backend, 'dz-2')
    _zone(backend, 'dz-other', created_by='adminuser')

    assert [z['id'] for z in backend.files.list_dropzones('testuser')] == [
        'dz-1', 'dz-2']
    assert [z['id'] for z in backend.files.list_dropzones('adminuser')] == [
        'dz-other']
    assert backend.files.list_dropzones('nobody') == []


def test_update_dropzone_fields(backend):
    _zone(backend)
    assert backend.files.update_dropzone_fields('dz-1', {
        'memo': 'for the contractor',
        'notification_sent_at': now_iso(),
        'another_extra': 42,
    }) is True

    zone = backend.files.get_dropzone('dz-1')
    assert zone['memo'] == 'for the contractor'
    assert zone['notification_sent_at'] is not None
    assert zone['another_extra'] == 42
    # untouched fields preserved
    assert zone['sv'] == _DZ_SV

    assert backend.files.update_dropzone_fields('nope', {'memo': 'x'}) is False


def test_consume_for_submission_stores_the_submission(backend):
    _zone(backend)

    result = backend.files.consume_for_submission(
        'dz-1', _DZ_SV, _submission_doc())
    assert result['status'] == 'ok'

    zone = backend.files.get_dropzone('dz-1')
    assert zone['link_consumed_at'] is not None
    sub = backend.files.get_dropzone_submission('dz-1')
    assert sub is not None
    assert sub['dropzone_id'] == 'dz-1'
    assert sub['path'] == 'uploads/sub-dz-1'
    assert sub['wk'] == _DZ_WK
    assert sub['receipt_hash'] == _DZ_RECEIPT_HASH
    assert sub['decryption_success'] is None
    assert [s['id'] for s in backend.files.list_dropzone_submissions()] == [
        'sub-dz-1']


def test_consume_for_submission_bad_sv_leaves_the_link_alive(backend):
    """No sv, no consume: a bare dropzone_id can't burn the request link."""
    _zone(backend)

    result = backend.files.consume_for_submission(
        'dz-1', _WRONG_SV, _submission_doc())
    assert result['status'] == 'bad_sv'
    assert backend.files.get_dropzone('dz-1')['link_consumed_at'] is None
    assert backend.files.get_dropzone_submission('dz-1') is None
    # a non-string or a missing stored sv can't pass the gate either
    assert backend.files.consume_for_submission(
        'dz-1', None, _submission_doc())['status'] == 'bad_sv'

    # the real responder's sv still wins afterwards
    result = backend.files.consume_for_submission(
        'dz-1', _DZ_SV, _submission_doc())
    assert result['status'] == 'ok'


def test_consume_for_submission_consumed_and_missing(backend):
    _consumed_zone(backend)

    result = backend.files.consume_for_submission(
        'dz-1', _DZ_SV, _submission_doc(id='sub-second'))
    assert result['status'] == 'consumed'
    # the first submission row stands; the loser's was never stored
    assert backend.files.get_dropzone_submission('dz-1')['id'] == 'sub-dz-1'

    assert backend.files.consume_for_submission(
        'ghost', _DZ_SV, _submission_doc('ghost'))['status'] == 'missing'


def test_consume_for_submission_expired_wipes_secrets(backend):
    """An expired zone dies on touch: marked expired, v/ws/sv wiped."""
    past = to_utc_iso(utcnow() - timedelta(minutes=5))
    _zone(backend, expiry_at=past)

    result = backend.files.consume_for_submission(
        'dz-1', _DZ_SV, _submission_doc())
    assert result['status'] == 'expired'
    zone = backend.files.get_dropzone('dz-1')
    assert zone['status'] == 'expired'
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None
    assert backend.files.get_dropzone_submission('dz-1') is None


def test_consume_for_submission_concurrent_single_winner(backend):
    """Racing submissions get exactly one winner — check+consume is one
    transaction, so two holders of the link can't both land."""
    _zone(backend)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda index: backend.files.consume_for_submission(
                'dz-1', _DZ_SV,
                _submission_doc(id=f'sub-{index}'))['status'],
            range(workers),
        ))

    assert results.count('ok') == 1
    assert results.count('consumed') == workers - 1
    subs = backend.files.list_dropzone_submissions()
    assert len(subs) == 1


def test_attempt_dropzone_release_statuses(backend):
    """The dropzone mirror of attempt_key_release — each attempt one
    transaction, ws handed out exactly once."""
    _consumed_zone(backend)

    # verifier miss → denied, attempts counted inside the attempt
    result = backend.files.attempt_dropzone_release('dz-1', _WRONG_V, 3, False)
    assert result['status'] == 'denied'
    assert result['attempts'] == 1
    assert result['attempts_remaining'] == 2
    assert backend.files.get_dropzone('dz-1')['attempts'] == 1

    # the right verifier releases wS once — and wipes v/ws/sv with the
    # claim, so a post-release DB theft yields nothing crackable
    result = backend.files.attempt_dropzone_release('dz-1', _DZ_V, 3, False)
    assert result['status'] == 'ok'
    assert result['ws'] == _DZ_WS
    zone = backend.files.get_dropzone('dz-1')
    assert zone['released_at'] is not None
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None

    # post-release attempts are refused — even with the right v
    assert backend.files.attempt_dropzone_release(
        'dz-1', _DZ_V, 3, False)['status'] == 'released'
    assert backend.files.attempt_dropzone_release(
        'dz-1', _WRONG_V, 3, False)['status'] == 'released'


def test_attempt_dropzone_release_before_submission(backend):
    """ws never leaves before a submission lands — there would be nothing
    to decrypt, and the zone dies with its first submission."""
    _zone(backend)

    result = backend.files.attempt_dropzone_release('dz-1', _DZ_V, 3, False)
    assert result['status'] == 'no_submission'
    # a no_submission gate is not a password miss — attempts untouched
    assert backend.files.get_dropzone('dz-1')['attempts'] == 0
    assert backend.files.attempt_dropzone_release(
        'dz-1', _WRONG_V, 3, False)['status'] == 'no_submission'
    assert backend.files.get_dropzone('dz-1')['attempts'] == 0


def test_attempt_dropzone_release_missing(backend):
    assert backend.files.attempt_dropzone_release(
        'ghost', _DZ_V, 3, False)['status'] == 'missing'


def test_attempt_dropzone_release_lockout(backend):
    """Exhausting attempts locks the zone; without burn the secrets stay."""
    _consumed_zone(backend)
    # max=1: the first miss is already the lockout event
    result = backend.files.attempt_dropzone_release('dz-1', _WRONG_V, 1, False)
    assert result['status'] == 'locked'
    zone = backend.files.get_dropzone('dz-1')
    assert zone['attempts'] == 1
    assert zone['released_at'] is None
    # lockout without burn keeps the secrets — availability lost, not wS
    assert zone['ws'] == _DZ_WS and zone['v'] == _DZ_V
    # even the correct verifier is refused after lockout
    assert backend.files.attempt_dropzone_release(
        'dz-1', _DZ_V, 1, False)['status'] == 'locked'


def test_attempt_dropzone_release_burn_on_lockout(backend):
    _consumed_zone(backend)
    result = backend.files.attempt_dropzone_release('dz-1', _WRONG_V, 1, True)
    assert result['status'] == 'locked'
    # burned: v/ws/sv wiped — wS is gone for good, the zone is dead
    zone = backend.files.get_dropzone('dz-1')
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None
    assert backend.files.attempt_dropzone_release(
        'dz-1', _DZ_V, 1, True)['status'] == 'locked'


def test_attempt_dropzone_release_expired(backend):
    """Expiry is decided inside the same transaction — and shreds the
    secrets; the submission path comes back for blob cleanup."""
    past = to_utc_iso(utcnow() - timedelta(minutes=5))
    _consumed_zone(backend)
    backend.files.update_dropzone_fields('dz-1', {'expiry_at': past})

    result = backend.files.attempt_dropzone_release('dz-1', _DZ_V, 3, False)
    assert result['status'] == 'expired'
    assert result['path'] == 'uploads/sub-dz-1'
    zone = backend.files.get_dropzone('dz-1')
    assert zone['status'] == 'expired'
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None


def test_attempt_dropzone_release_concurrent_single_winner(backend):
    """≥8 racing releases must produce exactly one wS."""
    _consumed_zone(backend)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda _i: backend.files.attempt_dropzone_release(
                'dz-1', _DZ_V, 8, False),
            range(workers),
        ))

    assert [r['status'] for r in results].count('ok') == 1
    assert [r['status'] for r in results].count('released') == workers - 1
    ws_values = {r['ws'] for r in results if r['status'] == 'ok'}
    assert ws_values == {_DZ_WS}


def test_claim_dropzone_submission(backend):
    _released_zone(backend)

    result = backend.files.claim_dropzone_submission('dz-1', '1.2.3.4')
    assert result['status'] == 'ok'
    assert result['path'] == 'uploads/sub-dz-1'
    assert result['wk'] == _DZ_WK
    assert result['type'] == 'file'
    assert result['submission_id'] == 'sub-dz-1'

    zone = backend.files.get_dropzone('dz-1')
    assert zone['collected_at'] is not None
    assert zone['collected_by_ip'] == '1.2.3.4'

    result = backend.files.claim_dropzone_submission('dz-1', '5.6.7.8')
    assert result['status'] == 'already_collected'


def test_claim_dropzone_submission_concurrent_single_winner(backend):
    """≥8 racing claims on a released zone produce exactly one blob."""
    _released_zone(backend)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda index: backend.files.claim_dropzone_submission(
                'dz-1', f'10.0.0.{index}')['status'],
            range(workers),
        ))

    assert results.count('ok') == 1
    assert results.count('already_collected') == workers - 1


def test_claim_dropzone_submission_guards(backend):
    _zone(backend, 'dz-missing')
    backend.files.delete_dropzone('dz-missing')
    assert backend.files.claim_dropzone_submission(
        'dz-missing', '1.2.3.4')['status'] == 'missing'

    # a consumed but never-released zone hands out nothing
    _consumed_zone(backend, 'dz-unreleased')
    assert backend.files.claim_dropzone_submission(
        'dz-unreleased', '1.2.3.4')['status'] == 'not_released'

    # released before any submission exists can't happen through the
    # release route — but a hand-built state still fails closed
    _zone(backend, 'dz-orphan')
    backend.files.update_dropzone_fields(
        'dz-orphan', {'released_at': now_iso()})
    assert backend.files.claim_dropzone_submission(
        'dz-orphan', '1.2.3.4')['status'] == 'no_submission'


def test_claim_dropzone_submission_honours_the_collect_window(backend):
    """A release left uncollected past the TTL expires in the claim's
    transaction — the blob comes back for the caller to delete."""
    _released_zone(backend, 'fresh')
    assert backend.files.claim_dropzone_submission(
        'fresh', '1.2.3.4', 3600)['status'] == 'ok'

    _released_zone(backend, 'stale')
    result = backend.files.claim_dropzone_submission('stale', '1.2.3.4', 0)
    assert result == {'status': 'expired', 'path': 'uploads/sub-stale'}
    zone = backend.files.get_dropzone('stale')
    assert zone['status'] == 'expired'
    assert zone['collected_at'] is None
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None


def test_claim_dropzone_submission_zone_expired(backend):
    past = to_utc_iso(utcnow() - timedelta(minutes=5))
    _released_zone(backend)
    backend.files.update_dropzone_fields('dz-1', {'expiry_at': past})
    result = backend.files.claim_dropzone_submission('dz-1', '1.2.3.4')
    assert result == {'status': 'expired', 'path': 'uploads/sub-dz-1'}


def test_delete_dropzone(backend):
    assert backend.files.delete_dropzone('nope') is None

    _zone(backend, 'dz-empty')
    assert backend.files.delete_dropzone('dz-empty') == {
        'existed': True, 'path': None}
    assert backend.files.get_dropzone('dz-empty') is None

    _consumed_zone(backend, 'dz-full')
    result = backend.files.delete_dropzone('dz-full')
    assert result == {'existed': True, 'path': 'uploads/sub-dz-full'}
    assert backend.files.get_dropzone('dz-full') is None
    assert backend.files.get_dropzone_submission('dz-full') is None
    assert backend.files.list_dropzone_submissions() == []


def test_purge_expired_dropzones(backend):
    """Zones past expiry_at are marked expired and shredded; submissions
    are listed for the caller's blob cleanup. Active zones untouched."""
    past = to_utc_iso(utcnow() - timedelta(minutes=5))
    _consumed_zone(backend, 'dz-expired')
    backend.files.update_dropzone_fields('dz-expired', {'expiry_at': past})
    _zone(backend, 'dz-expired-empty', expiry_at=past)
    _consumed_zone(backend, 'dz-live')
    _zone(backend, 'dz-no-expiry', expiry_at=None)

    expired = backend.files.purge_expired_dropzones()
    # only zones holding a submission are listed — the caller deletes blobs
    assert expired == [{'id': 'dz-expired', 'path': 'uploads/sub-dz-expired'}]

    for dropzone_id in ('dz-expired', 'dz-expired-empty'):
        zone = backend.files.get_dropzone(dropzone_id)
        assert zone['status'] == 'expired'
        assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None
        assert backend.files.get_dropzone_submission(dropzone_id) is None
    assert backend.files.get_dropzone('dz-live')['status'] == 'active'
    assert backend.files.get_dropzone_submission('dz-live') is not None

    # idempotent: a second pass finds nothing left
    assert backend.files.purge_expired_dropzones() == []


def test_expire_unclaimed_dropzone_releases(backend):
    """Only released, never-collected zones past the window expire."""
    _released_zone(backend, 'unclaimed')
    _released_zone(backend, 'collected')
    backend.files.claim_dropzone_submission('collected', '1.2.3.4')
    _consumed_zone(backend, 'unreleased')

    # inside the window nothing is touched
    assert backend.files.expire_unclaimed_dropzone_releases(3600) == []

    expired = backend.files.expire_unclaimed_dropzone_releases(0)
    assert expired == [{'id': 'unclaimed', 'path': 'uploads/sub-unclaimed'}]
    zone = backend.files.get_dropzone('unclaimed')
    assert zone['status'] == 'expired'
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None
    assert backend.files.get_dropzone_submission('unclaimed') is None
    assert backend.files.get_dropzone('collected')['status'] == 'active'
    assert backend.files.get_dropzone('unreleased')['status'] == 'active'

    assert backend.files.expire_unclaimed_dropzone_releases(0) == []


def test_record_dropzone_decryption_first_write_wins(backend):
    """The NULL-guarded conditional write — racing reports resolve to one."""
    _consumed_zone(backend)
    assert backend.files.record_dropzone_decryption('dz-1', True) is True
    assert backend.files.record_dropzone_decryption('dz-1', False) is False
    assert backend.files.get_dropzone_submission(
        'dz-1')['decryption_success'] is True
    assert backend.files.record_dropzone_decryption('nope', True) is False


def test_claim_dropzone_notification_send_once(backend):
    _zone(backend)
    assert backend.files.claim_dropzone_notification_send('dz-1') is True
    assert backend.files.claim_dropzone_notification_send('dz-1') is False

    backend.files.update_dropzone_fields(
        'dz-1', {'notification_sent_at': now_iso(),
                 'notification_claimed_at': None})
    assert backend.files.claim_dropzone_notification_send('dz-1') is False


def test_truncate_clears_dropzones(backend):
    _consumed_zone(backend)
    backend.files.truncate()
    assert backend.files.get_dropzone('dz-1') is None
    assert backend.files.list_dropzone_submissions() == []


# ---------------------------------------------------------------------------
# TokenStore contract
# ---------------------------------------------------------------------------

def _token_doc(**overrides):
    doc = {
        'token_hash': 'hash-' + os.urandom(4).hex(),
        'token_hash_version': 'pbkdf2-sha256-v1',
        'username': 'testuser',
        'created_at': now_iso(),
        'last_used_at': None,
        'expires_at': to_utc_iso(utcnow() + timedelta(days=30)),
    }
    doc.update(overrides)
    return doc


def test_token_insert_and_get(backend):
    doc_id = backend.tokens.insert(_token_doc(token_hash='abc123'))
    assert isinstance(doc_id, int)

    by_id = backend.tokens.get_by_id(doc_id)
    assert by_id is not None
    assert by_id['doc_id'] == doc_id
    assert by_id['token_hash'] == 'abc123'

    by_hash = backend.tokens.get_by_token_hash('abc123')
    assert by_hash['doc_id'] == doc_id
    assert backend.tokens.get_by_token_hash('missing') is None


def test_token_get_by_and_list_by(backend):
    backend.tokens.insert(_token_doc(username='u1'))
    backend.tokens.insert(_token_doc(username='u1'))
    backend.tokens.insert(_token_doc(username='u2'))

    assert backend.tokens.get_by(username='u2')['username'] == 'u2'
    assert len(backend.tokens.list_by(username='u1')) == 2


def test_token_update_fields(backend):
    doc_id = backend.tokens.insert(_token_doc())
    now = now_iso()
    assert backend.tokens.update_fields(doc_id, {
        'last_used_at': now,
        'token_hash_version': 'v2',
    }) is True

    stored = backend.tokens.get_by_id(doc_id)
    assert stored['last_used_at'] == now
    assert stored['token_hash_version'] == 'v2'


def test_token_remove_by_id_and_ids(backend):
    id1 = backend.tokens.insert(_token_doc())
    id2 = backend.tokens.insert(_token_doc())
    id3 = backend.tokens.insert(_token_doc())

    assert backend.tokens.remove_by_id(id1) is True
    assert backend.tokens.remove_by_id(id1) is False
    assert backend.tokens.remove_by_ids([id2, id3]) == 2
    assert backend.tokens.all() == []


def test_token_remove_by_hash(backend):
    backend.tokens.insert(_token_doc(token_hash='tok-hash-1'))
    backend.tokens.insert(_token_doc(token_hash='tok-hash-2'))

    assert backend.tokens.remove_by_hash('tok-hash-1') is True
    assert backend.tokens.remove_by_hash('tok-hash-1') is False
    assert [t['token_hash'] for t in backend.tokens.all()] == ['tok-hash-2']


def test_token_purge_expired(backend):
    past = to_utc_iso(utcnow() - timedelta(hours=1))
    future = to_utc_iso(utcnow() + timedelta(hours=1))
    backend.tokens.insert(_token_doc(expires_at=past))
    backend.tokens.insert(_token_doc(expires_at=future))
    backend.tokens.insert(_token_doc(expires_at=None))  # legacy: no stored expiry
    # malformed expiry is fail-closed: treated as expired, not kept valid
    backend.tokens.insert(_token_doc(expires_at='not-a-timestamp'))

    assert backend.tokens.purge_expired(now_iso()) == 2
    remaining = backend.tokens.all()
    assert len(remaining) == 2
    assert all(t['expires_at'] in (future, None) for t in remaining)


def test_tokens_truncate(backend):
    backend.tokens.insert(_token_doc())
    backend.tokens.truncate()
    assert backend.tokens.all() == []


# ---------------------------------------------------------------------------
# Factory contract
# ---------------------------------------------------------------------------

def test_create_backend_rejects_unknown_scheme():
    with pytest.raises(NotImplementedError, match='postgresql'):
        create_backend('postgresql://user:pass@host/db')
    with pytest.raises(NotImplementedError, match='mysql'):
        create_backend('mysql://user:pass@host/db')
