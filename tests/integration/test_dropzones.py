"""
Integration tests for dropzones — the reversed one-shot flow
(docs/adr/0001).

Covers the responder's page and submit route (public, sv-gated), the
requester's API (create/list/get), the password-first release, the
one-time submission download, the receipt report and delete — plus the
owner-only, CSRF and expiry behaviour on each.
"""
import base64
import hashlib
import io
import os
from datetime import timedelta
from timestamps import to_utc_iso, utcnow

import pytest
from flask import url_for

from auth import get_users
from conftest import CSRF_TOKEN, receipt_pair

# Fixtures: 'app', 'client', 'db_instance', 'files_store' from conftest.py
# Test users from conftest.py: 'testuser:password:false', 'adminuser:adminpass:true'

# The server never checks dropzone crypto — salt/v/sv/ws/wk are fixed hex
# dummies in the shapes the routes validate (32-hex salt, 64-hex
# material, 120-hex wrapped keys — iv(12)‖AES-GCM(32B) = 60 bytes).
_SALT = 'aa' * 16
_WS = 'bb' * 60
_V = 'cc' * 32
_SV = 'dd' * 32
_WK = 'ee' * 60
_WRONG_V = '22' * 32
_WRONG_SV = '33' * 32
RECEIPT, RECEIPT_HASH = receipt_pair()
# A BKD1 envelope: b'BKD1' ‖ iv(12) ‖ ciphertext. The magic is the only
# thing /dropzone/<id>/submit looks at.
BLOB = b'BKD1' + b'\x10' * 12 + b'\x99' * 48

CSRF_HEADERS = {'X-CSRF-Token': CSRF_TOKEN, 'X-Requested-With': 'XMLHttpRequest'}


def _collect_ticket(ws_hex=_WS):
    """The X-Collect-Ticket a collector derives from the released wS —
    HKDF-SHA256, zero salt, 'buzzdrop-collect-ticket'."""
    import hmac as _h
    prk = _h.new(b'\x00' * 32, bytes.fromhex(ws_hex), hashlib.sha256).digest()
    return _h.new(prk, b'buzzdrop-collect-ticket' + b'\x01',
                  hashlib.sha256).hexdigest()


def login_user(client, username='testuser', password='password'):
    response = client.post(
        url_for('login'),
        data={'username': username, 'password': password},
        follow_redirects=True,
    )
    with client.session_transaction() as session:
        session['csrf_token'] = CSRF_TOKEN
    return response


def _clear_csrf(client):
    """Remove the seeded session CSRF token — simulate a forged request."""
    with client.session_transaction() as session:
        session.pop('csrf_token', None)


def _api_token(app, username='testuser'):
    with app.app_context():
        from tokens import generate_api_token
        return generate_api_token(username)


def _create_payload(**overrides):
    payload = {'salt': _SALT, 'ws': _WS, 'v': _V, 'sv': _SV}
    payload.update(overrides)
    return payload


def _create_zone(client, **overrides):
    """POST /api/dropzones as the logged-in test user; returns the id."""
    response = client.post(
        url_for('create_dropzone'), json=_create_payload(**overrides),
        headers=CSRF_HEADERS)
    assert response.status_code == 200, response.get_json()
    return response.get_json()['dropzone_id']


def _submit(client, dropzone_id, sv=_SV, blob=BLOB, sub_type='file',
            receipt_hash=RECEIPT_HASH):
    """The responder's one shot — a multipart POST, no auth."""
    form = {
        'sv': sv,
        'wk': _WK,
        'receipt_hash': receipt_hash,
        'type': sub_type,
    }
    if sub_type == 'text':
        form['note_text'] = base64.b64encode(blob).decode()
    else:
        form['file'] = (io.BytesIO(blob), 'submission')
    return client.post(
        url_for('submit_dropzone', dropzone_id=dropzone_id),
        data=form, content_type='multipart/form-data')


def _submitted_zone(client):
    """A zone with a submission landed: create + submit."""
    dropzone_id = _create_zone(client)
    response = _submit(client, dropzone_id)
    assert response.status_code == 200, response.get_json()
    return dropzone_id


def _release(client, dropzone_id, v=_V, headers=None):
    return client.post(
        url_for('release_dropzone', dropzone_id=dropzone_id),
        json={'v': v}, headers=headers or CSRF_HEADERS)


@pytest.fixture
def dropzone_settings(app):
    """Mutate dropzone config and restore it afterwards."""
    keys = (
        'DROPZONE_SUBMIT_RATE_LIMIT',
        'DROPZONE_RELEASE_RATE_LIMIT',
        'DROPZONE_MAX_ATTEMPTS',
        'DROPZONE_BURN_ON_LOCKOUT',
        'DROPZONE_COLLECT_TTL_SECONDS',
    )
    original = {key: app.config.get(key) for key in keys}
    yield app.config
    app.config.update(original)


@pytest.fixture
def sent_messages(app, monkeypatch):
    """SMTP configured, testuser given an account email, _send_email captured."""
    monkeypatch.setenv('FLASK_USER_1', 'testuser:password:false:testuser@example.com')
    get_users.cache_clear()
    app.config.update({
        'SMTP_HOST': 'smtp.example.com',
        'SMTP_FROM_EMAIL': 'buzzdrop@example.com',
    })
    messages = []
    monkeypatch.setattr('app._send_email',
                        lambda recipient, subject, body: messages.append((recipient, subject, body)))
    return messages


# ---------------------------------------------------------------------------
# GET /dropzone/<id> — the responder's page
# ---------------------------------------------------------------------------

def test_respond_page_renders_for_a_live_zone(client):
    login_user(client)
    dropzone_id = _create_zone(client)

    response = client.get(url_for('respond_dropzone', dropzone_id=dropzone_id))
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'respond-config-json' in html
    assert f'/dropzone/{dropzone_id}/submit' in html


def test_respond_page_dead_zones_get_the_gone_page(client, files_store):
    """Missing, consumed and expired zones all answer the same uniform
    'drop is gone' page — it reveals nothing about which. Only the
    page's own address (the language menu's `next`) may differ."""
    login_user(client)
    consumed = _submitted_zone(client)
    expired = _create_zone(client)
    files_store.update_dropzone_fields(
        expired, {'expiry_at': to_utc_iso(utcnow() - timedelta(minutes=5))})

    bodies = []
    for dropzone_id in (consumed, expired, 'never-existed'):
        response = client.get(
            url_for('respond_dropzone', dropzone_id=dropzone_id))
        assert response.status_code == 404, dropzone_id
        assert 'This drop is gone' in response.get_data(as_text=True)
        bodies.append(response.get_data().replace(dropzone_id.encode(), b'<id>'))

    assert len(set(bodies)) == 1


# ---------------------------------------------------------------------------
# POST /api/dropzones — create
# ---------------------------------------------------------------------------

def test_create_dropzone(client, files_store):
    login_user(client)
    response = client.post(
        url_for('create_dropzone'),
        json=_create_payload(expiry='2099-01-01T00:00:00.000Z',
                             memo='for the contractor'),
        headers=CSRF_HEADERS)
    assert response.status_code == 200
    dropzone_id = response.get_json()['dropzone_id']

    zone = files_store.get_dropzone(dropzone_id)
    assert zone['salt'] == _SALT
    assert zone['ws'] == _WS
    assert zone['v'] == _V
    assert zone['sv'] == _SV
    assert zone['created_by'] == 'testuser'
    assert zone['memo'] == 'for the contractor'
    assert zone['expiry_at'] is not None
    assert zone['status'] == 'active'


def test_create_dropzone_requires_auth(client):
    response = client.post(
        url_for('create_dropzone'), json=_create_payload())
    assert response.status_code == 302
    assert url_for('login') in response.headers['Location']


def test_create_dropzone_requires_csrf_on_session(client):
    login_user(client)
    _clear_csrf(client)
    response = client.post(
        url_for('create_dropzone'), json=_create_payload())
    assert response.status_code == 403
    assert response.get_json()['code'] == 'csrf_failed'


def test_create_dropzone_bearer_exempt_from_csrf(client, app):
    token = _api_token(app)
    response = client.post(
        url_for('create_dropzone'), json=_create_payload(),
        headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    dropzone_id = response.get_json()['dropzone_id']
    # a Bearer request carries no page language — DEFAULT_LANGUAGE is stored
    assert client.get(
        url_for('get_dropzone_route', dropzone_id=dropzone_id),
        headers={'Authorization': f'Bearer {token}'}).status_code == 200


@pytest.mark.parametrize('field,value', [
    ('salt', 'aa' * 32),          # salt is 32 hex, not 64
    ('salt', 'zz' * 16),
    ('ws', 'short'),
    ('ws', 'zz' * 32),
    ('ws', 'bb' * 32),            # a bare key: wrapped keys are 120 hex
    ('v', 'cc' * 31),             # off by a byte
    ('sv', None),
])
def test_create_dropzone_rejects_bad_key_material(client, files_store, field, value):
    login_user(client)
    response = client.post(
        url_for('create_dropzone'), json=_create_payload(**{field: value}),
        headers=CSRF_HEADERS)
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_dropzone'
    assert files_store.list_dropzones('testuser') == []


@pytest.mark.parametrize('body', [
    'just-a-string',
    ['not', 'a', 'dict'],
    None,
])
def test_create_dropzone_rejects_non_dict_body(client, body):
    login_user(client)
    kwargs = {'json': body} if body is not None else {
        'data': '', 'content_type': 'application/json'}
    response = client.post(
        url_for('create_dropzone'), headers=CSRF_HEADERS, **kwargs)
    assert response.status_code == 400


def test_create_dropzone_rejects_zoneless_expiry(client):
    """An expiry must name an exact moment — a bare wall-clock time is refused."""
    login_user(client)
    response = client.post(
        url_for('create_dropzone'),
        json=_create_payload(expiry='2099-01-01T00:00'),
        headers=CSRF_HEADERS)
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_expiry'


def test_create_dropzone_notify_needs_an_account_email(client):
    """testuser has no configured email — notifications can't be enabled."""
    login_user(client)
    response = client.post(
        url_for('create_dropzone'),
        json=_create_payload(notify_on_submission=True),
        headers=CSRF_HEADERS)
    assert response.status_code == 400
    assert response.get_json()['code'] == 'account_email_missing'


def test_create_dropzone_notify_only_to_the_account_email(client, sent_messages):
    login_user(client)
    response = client.post(
        url_for('create_dropzone'),
        json=_create_payload(notify_on_submission=True,
                             notification_email='someone-else@example.com'),
        headers=CSRF_HEADERS)
    assert response.status_code == 400
    assert response.get_json()['code'] == 'notification_email_mismatch'


# ---------------------------------------------------------------------------
# GET /api/dropzones — the requester's list
# ---------------------------------------------------------------------------

def test_list_dropzones_shows_only_the_requesters(client):
    login_user(client)
    own = _create_zone(client, memo='mine')
    _submitted_zone(client)  # a second zone with a submission
    login_user(client, 'adminuser', 'adminpass')
    _create_zone(client, memo='theirs')

    response = client.get(url_for('list_dropzones_route'))
    assert response.status_code == 200
    zones = response.get_json()['dropzones']
    assert [z['memo'] for z in zones] == ['theirs']

    login_user(client)
    zones = client.get(url_for('list_dropzones_route')).get_json()['dropzones']
    assert len(zones) == 2
    by_memo = {z['memo']: z for z in zones}
    assert by_memo['mine']['id'] == own
    assert by_memo['mine']['link_consumed_at'] is None
    assert by_memo['mine']['submission'] is None
    landed = by_memo[None]
    assert landed['link_consumed_at'] is not None
    sub = landed['submission']
    assert sub['type'] == 'file'
    assert sub['decryption_success'] is None
    assert sub['created_at'] is not None
    assert sub['submitted_by_ip'] == '127.0.0.1'


def test_list_dropzones_requires_auth(client):
    response = client.get(url_for('list_dropzones_route'))
    assert response.status_code == 302


# ---------------------------------------------------------------------------
# GET /api/dropzones/<id> — collection metadata for the owner
# ---------------------------------------------------------------------------

def test_get_dropzone_hands_the_owner_salt_and_wk(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    response = client.get(
        url_for('get_dropzone_route', dropzone_id=dropzone_id))
    assert response.status_code == 200
    body = response.get_json()
    assert body['id'] == dropzone_id
    assert body['salt'] == _SALT
    assert body['link_consumed_at'] is not None
    sub = body['submission']
    assert sub['type'] == 'file'
    assert sub['wk'] == _WK
    assert sub['submitted_by_ip'] == '127.0.0.1'


def test_get_dropzone_is_owner_only(client):
    login_user(client)
    dropzone_id = _create_zone(client)

    login_user(client, 'adminuser', 'adminpass')
    response = client.get(
        url_for('get_dropzone_route', dropzone_id=dropzone_id))
    assert response.status_code == 404

    assert client.get(
        url_for('get_dropzone_route', dropzone_id='never-existed')
    ).status_code == 404


# ---------------------------------------------------------------------------
# GET /dropzones/<id>/collect — the requester's collect page
# ---------------------------------------------------------------------------

def test_collect_page_renders_for_the_owner(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    response = client.get(url_for('collect_dropzone', dropzone_id=dropzone_id))
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'collect-config-json' in html
    assert f'/dropzones/{dropzone_id}/release' in html
    assert f'/dropzones/{dropzone_id}/submission' in html
    # the zone's salt feeds the page's password KDF, like view's envelope salt
    assert _SALT in html


@pytest.mark.parametrize('value', [None, 'https://example.com/explainer', ''])
def test_collect_page_explainer_link_follows_the_setting(app, client, monkeypatch, value):
    """The link to the Website's explainer reads EXPLAINER_URL (#360); an
    empty value hides it."""
    if value is not None:
        monkeypatch.setitem(app.config, 'EXPLAINER_URL', value)
    login_user(client)
    dropzone_id = _submitted_zone(client)

    html = client.get(url_for('collect_dropzone', dropzone_id=dropzone_id)).get_data(as_text=True)

    expected = 'https://buzzdrop.io/how-it-works' if value is None else value
    assert (f'href="{expected}"' in html) == bool(expected)
    assert ('How it works' in html) == bool(expected)


def test_collect_page_renders_while_awaiting_and_released(client):
    """No submission yet renders — the release answers no_submission and
    the page words it; a released-but-uncollected zone still collects."""
    login_user(client)
    awaiting = _create_zone(client)
    assert client.get(
        url_for('collect_dropzone', dropzone_id=awaiting)).status_code == 200

    released = _submitted_zone(client)
    assert _release(client, released).status_code == 200
    assert client.get(
        url_for('collect_dropzone', dropzone_id=released)).status_code == 200


def test_collect_page_requires_login(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    anonymous = client.application.test_client()
    response = anonymous.get(
        url_for('collect_dropzone', dropzone_id=dropzone_id))
    assert response.status_code == 302
    assert url_for('login') in response.headers['Location']


def test_collect_page_is_owner_only(client):
    """Another account's zone answers the same uniform 'gone' page a dead
    link gets — the page reveals nothing about whose it is."""
    login_user(client)
    dropzone_id = _submitted_zone(client)

    login_user(client, 'adminuser', 'adminpass')
    response = client.get(url_for('collect_dropzone', dropzone_id=dropzone_id))
    assert response.status_code == 404
    assert 'This drop is gone' in response.get_data(as_text=True)


def test_collect_page_gone_for_collected_expired_and_missing(client, files_store):
    login_user(client)
    collected = _submitted_zone(client)
    assert _release(client, collected).status_code == 200
    assert client.get(
        url_for('collect_dropzone_submission', dropzone_id=collected),
        headers={'X-Collect-Ticket': _collect_ticket()}
    ).status_code == 200

    expired = _submitted_zone(client)
    files_store.update_dropzone_fields(
        expired, {'expiry_at': to_utc_iso(utcnow() - timedelta(minutes=5))})

    for dropzone_id in (collected, 'never-existed'):
        response = client.get(
            url_for('collect_dropzone', dropzone_id=dropzone_id))
        assert response.status_code == 404, dropzone_id
        assert 'This drop is gone' in response.get_data(as_text=True)

    # Expiry bounded the submit window, not collection — a landed
    # submission stays collectable past expiry_at.
    response = client.get(
        url_for('collect_dropzone', dropzone_id=expired))
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# POST /dropzone/<id>/submit — the responder's shot (public)
# ---------------------------------------------------------------------------

def test_submit_stores_the_submission_and_consumes_the_link(client, files_store, app):
    login_user(client)
    dropzone_id = _create_zone(client)

    response = _submit(client, dropzone_id)
    assert response.status_code == 200
    assert response.get_json() == {'status': 'submitted'}

    zone = files_store.get_dropzone(dropzone_id)
    assert zone['link_consumed_at'] is not None
    sub = files_store.get_dropzone_submission(dropzone_id)
    assert sub['type'] == 'file'
    assert sub['wk'] == _WK
    assert sub['receipt_hash'] == RECEIPT_HASH
    assert sub['decryption_success'] is None
    # the BKD1 blob landed in storage
    assert os.path.exists(sub['path'])
    with open(sub['path'], 'rb') as handle:
        assert handle.read() == BLOB


def test_submit_is_public(client):
    """The responder needs no account — submit works with no session."""
    login_user(client)
    dropzone_id = _create_zone(client)

    other = client.application.test_client()
    response = _submit(other, dropzone_id)
    assert response.status_code == 200


def test_submit_bad_sv_leaves_the_link_alive(client):
    """403 invalid_link, and the zone is NOT consumed — a bare dropzone_id
    from logs can't burn the request link."""
    login_user(client)
    dropzone_id = _create_zone(client)

    response = _submit(client, dropzone_id, sv=_WRONG_SV)
    assert response.status_code == 403
    assert response.get_json()['code'] == 'invalid_link'

    # the page still renders, and the real responder's sv still submits
    assert client.get(
        url_for('respond_dropzone', dropzone_id=dropzone_id)).status_code == 200
    assert _submit(client, dropzone_id).status_code == 200


def test_submit_second_submission_is_consumed(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    response = _submit(client, dropzone_id)
    assert response.status_code == 410
    assert response.get_json()['code'] == 'consumed'


def test_submit_missing_zone_is_404(client):
    response = _submit(client, 'never-existed')
    assert response.status_code == 404
    assert response.get_json()['code'] == 'not_found'


def test_submit_expired_zone_is_410(client, files_store):
    login_user(client)
    dropzone_id = _create_zone(client)
    files_store.update_dropzone_fields(
        dropzone_id, {'expiry_at': to_utc_iso(utcnow() - timedelta(minutes=5))})

    response = _submit(client, dropzone_id)
    assert response.status_code == 410
    assert response.get_json()['code'] == 'expired'
    # expiry wiped the secrets inside the consume's transaction
    zone = files_store.get_dropzone(dropzone_id)
    assert zone['status'] == 'expired'
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None


@pytest.mark.parametrize('form_overrides', [
    {'type': 'bogus'},
    {'sv': 'zz' * 32},
    {'sv': 'dd' * 31},
    {'wk': 'short'},
    {'receipt_hash': 'not-hex'},
])
def test_submit_rejects_bad_fields(client, form_overrides):
    login_user(client)
    dropzone_id = _create_zone(client)

    form = {
        'sv': _SV, 'wk': _WK, 'receipt_hash': RECEIPT_HASH, 'type': 'file',
        'file': (io.BytesIO(BLOB), 'submission'),
    }
    form.update(form_overrides)
    response = client.post(
        url_for('submit_dropzone', dropzone_id=dropzone_id),
        data=form, content_type='multipart/form-data')
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_submission'


def test_submit_rejects_non_bkd1_blob(client, files_store):
    """Only the BKD1 envelope is accepted — the magic is checked and a
    refused submission must leave nothing behind."""
    login_user(client)
    dropzone_id = _create_zone(client)

    response = _submit(client, dropzone_id, blob=b'PLAIN' + b'\x00' * 60)
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_submission'

    # no blob, no submission row — the link stays alive
    assert files_store.get_dropzone_submission(dropzone_id) is None
    assert client.get(
        url_for('respond_dropzone', dropzone_id=dropzone_id)).status_code == 200


def test_submit_text_note(client, files_store):
    login_user(client)
    dropzone_id = _create_zone(client)

    response = _submit(client, dropzone_id, sub_type='text')
    assert response.status_code == 200
    sub = files_store.get_dropzone_submission(dropzone_id)
    assert sub['type'] == 'text'
    with open(sub['path'], 'rb') as handle:
        assert handle.read() == BLOB


def test_submit_note_without_text_is_invalid(client):
    login_user(client)
    dropzone_id = _create_zone(client)
    response = client.post(
        url_for('submit_dropzone', dropzone_id=dropzone_id),
        data={'sv': _SV, 'wk': _WK, 'receipt_hash': RECEIPT_HASH,
              'type': 'text'},
        content_type='multipart/form-data')
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_submission'


def test_submit_without_file_is_invalid(client):
    login_user(client)
    dropzone_id = _create_zone(client)
    response = client.post(
        url_for('submit_dropzone', dropzone_id=dropzone_id),
        data={'sv': _SV, 'wk': _WK, 'receipt_hash': RECEIPT_HASH,
              'type': 'file'},
        content_type='multipart/form-data')
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_submission'


def test_submit_sends_the_notification_email(client, files_store, sent_messages):
    """notify_on_submission emails the requester's configured address when
    a submission lands — fired at submit, not at collection."""
    login_user(client)
    dropzone_id = _create_zone(client, notify_on_submission=True)
    assert files_store.get_dropzone(dropzone_id)['notify_on_submission'] is True

    response = _submit(client, dropzone_id)
    assert response.status_code == 200

    [(recipient, subject, body)] = sent_messages
    assert recipient == 'testuser@example.com'
    assert subject == 'Buzzdrop submission received'
    assert 'Received at: ' in body
    # the responder's identity stays out of the mail
    assert dropzone_id not in body


def test_submit_without_notify_sends_no_email(client, sent_messages):
    login_user(client)
    dropzone_id = _create_zone(client)
    _submit(client, dropzone_id)
    assert sent_messages == []


# ---------------------------------------------------------------------------
# POST /dropzones/<id>/release — password-first collection
# ---------------------------------------------------------------------------

def test_release_wrong_v_then_right(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    miss = _release(client, dropzone_id, v=_WRONG_V)
    assert miss.status_code == 403
    assert miss.get_json()['error'] == 'Incorrect password'
    assert miss.get_json()['attempts_remaining'] == 2  # DROPZONE_MAX_ATTEMPTS=3

    release = _release(client, dropzone_id)
    assert release.status_code == 200
    assert release.get_json()['ws'] == _WS

    zone = files_store.get_dropzone(dropzone_id)
    assert zone['released_at'] is not None
    # the release wiped the secrets — wS is handed out exactly once
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None

    again = _release(client, dropzone_id)
    assert again.status_code == 410


def test_release_before_submission_is_409(client, files_store):
    login_user(client)
    dropzone_id = _create_zone(client)

    response = _release(client, dropzone_id)
    assert response.status_code == 409
    assert response.get_json()['code'] == 'no_submission'
    # a no_submission refusal costs no attempt
    assert files_store.get_dropzone(dropzone_id)['attempts'] == 0


def test_release_lockout(client, dropzone_settings, files_store):
    """DROPZONE_BURN_ON_LOCKOUT defaults off: lockout keeps the secrets,
    refusing releases — the stranded submission argument of the ADR."""
    dropzone_settings['DROPZONE_MAX_ATTEMPTS'] = 2
    login_user(client)
    dropzone_id = _submitted_zone(client)

    for expected in (403, 429):
        response = _release(client, dropzone_id, v=_WRONG_V)
        assert response.status_code == expected

    # even the correct verifier is refused after lockout
    assert _release(client, dropzone_id).status_code == 429
    zone = files_store.get_dropzone(dropzone_id)
    assert zone['attempts'] == 2
    assert zone['ws'] == _WS  # availability lost, not the secret


def test_release_burn_on_lockout_wipes_secrets(client, dropzone_settings, files_store):
    dropzone_settings['DROPZONE_MAX_ATTEMPTS'] = 1
    dropzone_settings['DROPZONE_BURN_ON_LOCKOUT'] = True
    login_user(client)
    dropzone_id = _submitted_zone(client)

    response = _release(client, dropzone_id, v=_WRONG_V)
    assert response.status_code == 429
    zone = files_store.get_dropzone(dropzone_id)
    assert zone['v'] is None and zone['ws'] is None and zone['sv'] is None
    assert _release(client, dropzone_id).status_code == 429


def test_release_expired_zone_is_410(client, files_store):
    login_user(client)
    # Never-submitted: expiry kills the zone outright.
    dropzone_id = _create_zone(client)
    files_store.update_dropzone_fields(
        dropzone_id, {'expiry_at': to_utc_iso(utcnow() - timedelta(minutes=5))})

    response = _release(client, dropzone_id)
    assert response.status_code == 410
    assert response.get_json()['code'] == 'expired'
    assert files_store.get_dropzone(dropzone_id)['status'] == 'expired'


def test_release_expired_zone_with_submission_still_releases(client, files_store):
    # Expiry bounds the request link, not collection: a submission that
    # landed before the deadline stays collectable.
    login_user(client)
    dropzone_id = _submitted_zone(client)
    path = files_store.get_dropzone_submission(dropzone_id)['path']
    files_store.update_dropzone_fields(
        dropzone_id, {'expiry_at': to_utc_iso(utcnow() - timedelta(minutes=5))})

    response = _release(client, dropzone_id)
    assert response.status_code == 200
    assert response.get_json()['ws'] == _WS
    assert os.path.exists(path)


def test_release_is_owner_only(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    login_user(client, 'adminuser', 'adminpass')
    response = _release(client, dropzone_id)
    assert response.status_code == 404


def test_release_missing_zone_is_404(client):
    login_user(client)
    response = _release(client, 'never-existed')
    assert response.status_code == 404


@pytest.mark.parametrize('body', [
    {},
    {'v': 'short'},
    {'v': 'zz' * 32},
    {'v': 123},
    {'v': None},
    ['not', 'a', 'dict'],
])
def test_release_requires_valid_verifier(client, files_store, body):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    response = client.post(
        url_for('release_dropzone', dropzone_id=dropzone_id),
        json=body, headers=CSRF_HEADERS)
    assert response.status_code == 400
    # malformed attempts must not drain the counter
    assert files_store.get_dropzone(dropzone_id)['attempts'] == 0


def test_release_requires_csrf_on_session(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    _clear_csrf(client)
    response = client.post(
        url_for('release_dropzone', dropzone_id=dropzone_id),
        json={'v': _V})
    assert response.status_code == 403
    assert response.get_json()['code'] == 'csrf_failed'


def test_release_bearer_exempt_from_csrf(client, app):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    token = _api_token(app)
    response = client.post(
        url_for('release_dropzone', dropzone_id=dropzone_id),
        json={'v': _V},
        headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    assert response.get_json()['ws'] == _WS


# ---------------------------------------------------------------------------
# GET /dropzones/<id>/submission — the one-time blob fetch
# ---------------------------------------------------------------------------

def test_submission_downloads_once(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    path = files_store.get_dropzone_submission(dropzone_id)['path']

    # nothing to fetch before the release — the blob is gated on it
    refused = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id))
    assert refused.status_code == 403

    release = _release(client, dropzone_id)
    assert release.status_code == 200

    download = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id),
        headers={'X-Collect-Ticket': _collect_ticket()})
    assert download.status_code == 200
    assert download.data == BLOB
    # the stream consumed the claim AND deleted the blob
    assert not os.path.exists(path)

    again = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id))
    assert again.status_code == 410
    assert again.get_json()['code'] == 'collected'


def test_submission_download_needs_the_collect_ticket(client):
    """The bare URL can't burn the one-shot claim: no ticket or a wrong
    one → 410 'claimed', and the claim stays live for the real winner."""
    login_user(client)
    dropzone_id = _submitted_zone(client)
    assert _release(client, dropzone_id).status_code == 200

    no_ticket = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id))
    assert no_ticket.status_code == 410
    assert no_ticket.get_json()['code'] == 'claimed'

    wrong_ticket = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id),
        headers={'X-Collect-Ticket': _collect_ticket('ff' * 60)})
    assert wrong_ticket.status_code == 410

    # the claim itself survived both
    ok = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id),
        headers={'X-Collect-Ticket': _collect_ticket()})
    assert ok.status_code == 200


def test_submission_download_window_closes(client, files_store, dropzone_settings):
    """A release left uncollected past DROPZONE_COLLECT_TTL_SECONDS expires:
    the zone dies, the blob is deleted."""
    login_user(client)
    dropzone_id = _submitted_zone(client)
    path = files_store.get_dropzone_submission(dropzone_id)['path']
    assert _release(client, dropzone_id).status_code == 200

    dropzone_settings['DROPZONE_COLLECT_TTL_SECONDS'] = 0
    download = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id))
    assert download.status_code == 410
    assert download.get_json()['code'] == 'expired'
    assert files_store.get_dropzone(dropzone_id)['status'] == 'expired'
    assert not os.path.exists(path)


def test_submission_is_owner_only(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    assert _release(client, dropzone_id).status_code == 200

    login_user(client, 'adminuser', 'adminpass')
    response = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id))
    assert response.status_code == 404
    # and it stays uncollected for the real owner
    assert client.get(
        url_for('get_dropzone_route', dropzone_id=dropzone_id)
    ).status_code == 404


def test_submission_missing_zone_is_404(client):
    login_user(client)
    response = client.get(
        url_for('collect_dropzone_submission', dropzone_id='never-existed'))
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /dropzones/<id>/report — proof-of-decryption
# ---------------------------------------------------------------------------

def test_report_records_the_decryption(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    assert _release(client, dropzone_id).status_code == 200
    client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id),
        headers={'X-Collect-Ticket': _collect_ticket()})

    response = client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json={'success': True, 'receipt': RECEIPT})
    assert response.status_code == 200
    assert response.get_json() == {'status': 'recorded'}
    assert files_store.get_dropzone_submission(
        dropzone_id)['decryption_success'] is True


def test_report_rejects_a_wrong_receipt(client):
    login_user(client)
    dropzone_id = _submitted_zone(client)

    response = client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json={'success': True, 'receipt': '44' * 32})
    assert response.status_code == 403
    assert response.get_json()['error'] == 'Invalid receipt'


def test_report_needs_a_submission(client):
    login_user(client)
    dropzone_id = _create_zone(client)
    response = client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json={'success': True, 'receipt': RECEIPT})
    assert response.status_code == 404
    assert client.post(
        url_for('report_dropzone_decryption', dropzone_id='never-existed'),
        json={'success': True, 'receipt': RECEIPT}).status_code == 404


@pytest.mark.parametrize('body', [
    {},
    {'success': 'yes', 'receipt': RECEIPT},
    {'success': True, 'receipt': 'short'},
    {'success': True},
    ['not', 'a', 'dict'],
])
def test_report_requires_valid_body(client, body):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    response = client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json=body)
    assert response.status_code == 400


def test_report_first_write_wins(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    report = lambda success: client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json={'success': success, 'receipt': RECEIPT})

    assert report(True).status_code == 200
    assert report(False).status_code == 200
    assert files_store.get_dropzone_submission(
        dropzone_id)['decryption_success'] is True


# ---------------------------------------------------------------------------
# POST /dropzones/<id>/delete
# ---------------------------------------------------------------------------

def test_delete_dropzone_removes_zone_submission_and_blob(client, files_store):
    login_user(client)
    dropzone_id = _submitted_zone(client)
    path = files_store.get_dropzone_submission(dropzone_id)['path']

    response = client.post(
        url_for('delete_dropzone', dropzone_id=dropzone_id),
        headers=CSRF_HEADERS)
    assert response.status_code == 200
    assert response.get_json() == {'status': 'deleted'}
    assert files_store.get_dropzone(dropzone_id) is None
    assert files_store.get_dropzone_submission(dropzone_id) is None
    assert not os.path.exists(path)
    # the request link dies with it
    assert client.get(
        url_for('respond_dropzone', dropzone_id=dropzone_id)).status_code == 404


def test_delete_dropzone_is_owner_only(client, files_store):
    login_user(client)
    dropzone_id = _create_zone(client)

    login_user(client, 'adminuser', 'adminpass')
    response = client.post(
        url_for('delete_dropzone', dropzone_id=dropzone_id),
        headers=CSRF_HEADERS)
    assert response.status_code == 404
    assert files_store.get_dropzone(dropzone_id) is not None


def test_delete_dropzone_requires_csrf_on_session(client):
    login_user(client)
    dropzone_id = _create_zone(client)
    _clear_csrf(client)
    response = client.post(
        url_for('delete_dropzone', dropzone_id=dropzone_id))
    assert response.status_code == 403


def test_delete_dropzone_missing_is_404(client):
    login_user(client)
    response = client.post(
        url_for('delete_dropzone', dropzone_id='never-existed'),
        headers=CSRF_HEADERS)
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# The whole journey
# ---------------------------------------------------------------------------

def test_dropzone_round_trip(client, files_store):
    """create → respond page → submit → wrong-v → release → collect →
    second fetch refused → report — the reversed mirror of a drop."""
    login_user(client)
    dropzone_id = _create_zone(client)

    responder = client.application.test_client()
    assert responder.get(
        url_for('respond_dropzone', dropzone_id=dropzone_id)).status_code == 200
    assert _submit(responder, dropzone_id, sv=_WRONG_SV).status_code == 403
    assert _submit(responder, dropzone_id).status_code == 200
    # the link is spent
    assert responder.get(
        url_for('respond_dropzone', dropzone_id=dropzone_id)).status_code == 404

    miss = _release(client, dropzone_id, v=_WRONG_V)
    assert miss.status_code == 403
    assert miss.get_json()['attempts_remaining'] == 2

    release = _release(client, dropzone_id)
    assert release.status_code == 200
    assert release.get_json()['ws'] == _WS

    download = client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id),
        headers={'X-Collect-Ticket': _collect_ticket()})
    assert download.status_code == 200
    assert download.data == BLOB

    assert client.get(
        url_for('collect_dropzone_submission', dropzone_id=dropzone_id)
    ).status_code == 410

    report = client.post(
        url_for('report_dropzone_decryption', dropzone_id=dropzone_id),
        json={'success': True, 'receipt': RECEIPT})
    assert report.status_code == 200
    assert files_store.get_dropzone_submission(
        dropzone_id)['decryption_success'] is True
