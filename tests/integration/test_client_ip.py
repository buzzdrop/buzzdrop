"""
The real app behind a host's proxy (#422): drop links and the client IP
that the limiter and stored records use follow proxy.py.
"""
import pytest
from flask import request_started, url_for

import proxy
from conftest import download_ticket
from utils import get_client_ip

RENDER_HEADERS = {
    'True-Client-IP': '203.0.113.7',
    'X-Forwarded-For': '1.2.3.4, 203.0.113.7, 10.0.0.9',
    'X-Forwarded-Proto': 'https',
}


@pytest.fixture
def behind_render(app, monkeypatch):
    """The app as Render runs it: CLIENT_IP_HEADER=True-Client-IP."""
    bare = app.wsgi_app
    if isinstance(bare, proxy.UntrustedProxyWarning):
        bare = bare.app
    monkeypatch.setattr(app, 'wsgi_app', proxy.wrap(bare, 0, 'True-Client-IP'))


@pytest.fixture
def seen_client_ips(app):
    """The client IP each request resolved to, as the limiter keys it."""
    seen = []

    def record(sender, **extra):
        seen.append(get_client_ip())

    request_started.connect(record, app)
    yield seen
    request_started.disconnect(record, app)


def _login(client):
    with client.session_transaction() as sess:
        sess['username'] = 'testuser'
        sess['is_admin'] = False


def test_a_drop_link_is_https_behind_a_tls_proxy(client, behind_render, key_release_upload):
    _login(client)

    _file_id, _h, _receipt, response = key_release_upload(
        headers={**RENDER_HEADERS, 'X-Requested-With': 'XMLHttpRequest'})

    assert response.status_code == 200
    assert response.get_json()['share_link'].startswith('https://')


def test_the_client_ip_is_the_header_not_the_proxy(client, behind_render, seen_client_ips):
    client.get('/login', headers=RENDER_HEADERS, environ_base={'REMOTE_ADDR': '10.0.0.9'})

    assert seen_client_ips == ['203.0.113.7']


def test_the_recorded_download_ip_is_the_header_not_the_proxy(
        client, behind_render, key_release_upload, files_store):
    _login(client)
    file_id, _h, _receipt, _response = key_release_upload(
        headers={**RENDER_HEADERS, 'X-Requested-With': 'XMLHttpRequest'})
    proxied = {'headers': RENDER_HEADERS, 'environ_base': {'REMOTE_ADDR': '10.0.0.9'}}

    release = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'cc' * 32}, **proxied)
    download = client.get(
        url_for('download_file', file_id=file_id),
        headers={**RENDER_HEADERS, 'X-Download-Ticket': download_ticket(release.get_json()['h'])},
        environ_base={'REMOTE_ADDR': '10.0.0.9'})

    assert download.status_code == 200
    assert files_store.get_by_id(file_id)['downloaded_by_ip'] == '203.0.113.7'


def test_without_a_setting_the_client_ip_is_the_connection(client, seen_client_ips):
    client.get('/login', headers=RENDER_HEADERS, environ_base={'REMOTE_ADDR': '10.0.0.9'})

    assert seen_client_ips == ['10.0.0.9']
