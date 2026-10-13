"""The stable ``code`` on JSON error responses the web UI may show (#285).

The browser maps ``code`` to its own message and never displays ``error``,
which stays English for the CLI and other API clients.
"""
import io

import pytest
from flask import url_for

import app as app_module
from auth import get_users
from conftest import CSRF_TOKEN


def login(client, username='testuser', password='password'):
    client.post(url_for('login'), data={'username': username, 'password': password})
    with client.session_transaction() as session:
        session['csrf_token'] = CSRF_TOKEN


def assert_refused(response, status, code, error):
    assert response.status_code == status
    assert response.get_json() == {'error': error, 'code': code}


@pytest.fixture
def restore_config(app):
    original = dict(app.config)
    yield
    app.config.clear()
    app.config.update(original)


# --- /upload (the index page's XHR) ----------------------------------------

def test_upload_without_csrf(client, key_release_upload):
    login(client)
    _id, _h, _r, response = key_release_upload(data={'csrf_token': ''})
    assert_refused(response, 403, 'csrf_failed', 'CSRF validation failed')


def test_upload_with_invalid_key_material(client, key_release_upload):
    login(client)
    _id, _h, _r, response = key_release_upload(verifier='not-hex')
    assert_refused(response, 400, 'invalid_upload', 'Invalid key-release upload')


def post_upload(client, file_id):
    """Finish ``file_id`` as the page's XHR does."""
    return client.post(
        '/upload', content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
        data={'file': (io.BytesIO(b'x'), 'a.txt'), 'file_id': file_id,
              'key_verifier': 'cc' * 32, 'receipt_hash': 'dd' * 32,
              'csrf_token': CSRF_TOKEN})


def test_upload_to_a_finished_share(client, key_release_upload):
    login(client)
    file_id, _h, _r, first = key_release_upload()
    assert first.status_code == 200
    assert_refused(post_upload(client, file_id), 409, 'share_unavailable',
                   'Unknown or already finalized key-release upload')


def test_upload_to_another_accounts_share(client, key_share):
    login(client)
    other_id, _h = key_share(created_by='adminuser')
    assert_refused(post_upload(client, other_id), 403, 'share_not_owned',
                   'Key-release share belongs to another user')


def test_upload_with_a_zoneless_expiry(client, key_release_upload):
    login(client)
    _id, _h, _r, response = key_release_upload(data={'expiry': '2099-01-01T00:00'})
    assert_refused(response, 400, 'invalid_expiry',
                   'Expiry must be an ISO 8601 time with a time zone, e.g. 2026-12-31T23:59+01:00')


def test_upload_of_a_disallowed_type(client, key_release_upload):
    login(client)
    _id, _h, _r, response = key_release_upload(filename='test.exe')
    assert_refused(response, 400, 'type_not_allowed', 'File type not allowed')


def test_upload_that_fails_to_store(client, key_release_upload, monkeypatch):
    login(client)

    def broken_save(*_args, **_kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(app_module.storage, 'save', broken_save)
    _id, _h, _r, response = key_release_upload()
    assert_refused(response, 500, 'upload_failed', 'Upload failed')


def test_upload_too_large(client, app, key_release_upload, restore_config):
    login(client)
    app.config['MAX_CONTENT_LENGTH'] = 64
    _id, _h, _r, response = key_release_upload(content=b'x' * 128)
    assert_refused(response, 413, 'file_too_large', 'File too large')


@pytest.mark.parametrize('smtp_host, account, code, error', [
    (None, 'testuser:password:false', 'notifications_unconfigured',
     'Open notifications are not configured on this server'),
    ('smtp.example.com', 'testuser:password:false', 'account_email_missing',
     'Configure an account email before enabling open notifications'),
    ('smtp.example.com', 'testuser:password:false:@example.com', 'account_email_invalid',
     'Your configured account email is invalid'),
])
def test_upload_with_a_refused_open_notification(
        client, app, key_release_upload, monkeypatch, restore_config,
        smtp_host, account, code, error):
    monkeypatch.setenv('FLASK_USER_1', account)
    get_users.cache_clear()
    login(client)
    app.config.update({'SMTP_HOST': smtp_host, 'SMTP_FROM_EMAIL': 'buzzdrop@example.com'})
    _id, _h, _r, response = key_release_upload(data={'notify_on_open': 'true'})
    assert_refused(response, 400, code, error)


def test_upload_notifying_another_address(client, app, key_release_upload, monkeypatch, restore_config):
    monkeypatch.setenv('FLASK_USER_1', 'testuser:password:false:testuser@example.com')
    get_users.cache_clear()
    login(client)
    app.config.update({'SMTP_HOST': 'smtp.example.com', 'SMTP_FROM_EMAIL': 'buzzdrop@example.com'})
    _id, _h, _r, response = key_release_upload(
        data={'notify_on_open': 'true', 'notification_email': 'other@example.com'})
    assert_refused(response, 400, 'notification_email_mismatch',
                   'Open notifications can only be sent to your configured account email')


def test_upload_rate_limited(client, app, key_release_upload, restore_config):
    login(client)
    app.config['UPLOAD_RATE_LIMIT'] = '1 per minute'
    key_release_upload()
    _id, _h, _r, response = key_release_upload()
    assert_refused(response, 429, 'rate_limited', 'Too many requests. Please try again later.')


# --- /api/token (the users page) -------------------------------------------

def test_token_without_csrf(client):
    login(client)
    response = client.post(url_for('create_api_token'), json={'username': 'testuser'})
    assert_refused(response, 403, 'csrf_failed', 'CSRF validation failed')


def test_token_for_another_user_as_non_admin(client):
    login(client)
    response = client.post(url_for('create_api_token'),
                           json={'username': 'adminuser', 'csrf_token': CSRF_TOKEN})
    assert_refused(response, 403, 'admin_required',
                   'Admin access required to generate tokens for other users')


def test_token_for_an_unknown_user(client):
    login(client, 'adminuser', 'adminpass')
    response = client.post(url_for('create_api_token'),
                           json={'username': 'nobody', 'csrf_token': CSRF_TOKEN})
    assert_refused(response, 404, 'unknown_user', 'Unknown user')


def test_token_with_an_invalid_expiry(client):
    login(client)
    response = client.post(url_for('create_api_token'),
                           json={'expires_in_days': 0, 'csrf_token': CSRF_TOKEN})
    assert_refused(response, 400, 'invalid_expiry_days',
                   'expires_in_days must be a positive integer')
