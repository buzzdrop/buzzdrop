"""
The real client IP and scheme behind a host's proxy (proxy.py, #422).
"""
import logging

import pytest
from flask import Flask, request, url_for

import proxy
from config import Config


def _client(hops=0, header=None):
    app = Flask(__name__)

    @app.route('/whoami')
    def whoami():
        return {
            'ip': request.remote_addr,
            'secure': request.is_secure,
            'link': url_for('whoami', _external=True),
        }

    app.wsgi_app = proxy.wrap(app.wsgi_app, hops, header)
    return app.test_client()


def _get(client, headers, remote='10.0.0.9'):
    return client.get('/whoami', headers=headers,
                      environ_base={'REMOTE_ADDR': remote}).get_json()


# --- CLIENT_IP_HEADER (Render: True-Client-IP) -----------------------------

def test_the_client_ip_comes_from_the_named_header():
    body = _get(_client(header='True-Client-IP'), {
        'True-Client-IP': '203.0.113.7',
        'X-Forwarded-For': '198.51.100.1, 203.0.113.7, 10.0.0.9',
        'X-Forwarded-Proto': 'https',
    })

    assert body['ip'] == '203.0.113.7'
    assert body['secure'] is True
    assert body['link'].startswith('https://')


def test_a_forged_x_forwarded_for_changes_nothing_in_header_mode():
    body = _get(_client(header='True-Client-IP'), {
        'True-Client-IP': '203.0.113.7',
        'X-Forwarded-For': '1.2.3.4',
    })

    assert body['ip'] == '203.0.113.7'


def test_a_missing_header_falls_back_to_the_connection_and_warns_once(caplog):
    client = _client(header='True-Client-IP')

    with caplog.at_level(logging.WARNING, logger='proxy'):
        first = _get(client, {})
        second = _get(client, {'True-Client-IP': 'not-an-ip'})

    assert first['ip'] == second['ip'] == '10.0.0.9'
    assert len(caplog.records) == 1
    assert 'CLIENT_IP_HEADER=True-Client-IP' in caplog.text


def test_a_health_probe_without_the_header_does_not_use_up_the_warning(caplog):
    # Render's health check and the image's HEALTHCHECK come from inside,
    # without True-Client-IP; the first real request still warns.
    app = Flask(__name__)
    app.add_url_rule('/healthz', 'healthz', lambda: 'ok')
    app.add_url_rule('/login', 'login', lambda: 'login')
    app.wsgi_app = proxy.wrap(app.wsgi_app, 0, 'True-Client-IP')
    client = app.test_client()

    with caplog.at_level(logging.WARNING, logger='proxy'):
        client.get('/healthz')
        assert caplog.records == []
        client.get('/login')

    assert len(caplog.records) == 1


# --- TRUSTED_PROXY_HOPS ----------------------------------------------------

def test_one_hop_trusts_only_the_rightmost_x_forwarded_for_entry():
    body = _get(_client(hops=1), {
        'X-Forwarded-For': '1.2.3.4, 203.0.113.7',
        'X-Forwarded-Proto': 'https',
    })

    assert body['ip'] == '203.0.113.7'
    assert body['link'].startswith('https://')


def test_hops_never_trust_x_forwarded_host():
    body = _get(_client(hops=1), {
        'X-Forwarded-For': '203.0.113.7',
        'X-Forwarded-Host': 'evil.example',
    })

    assert 'evil.example' not in body['link']


def test_forwarded_is_never_read():
    body = _get(_client(hops=1), {'Forwarded': 'for=1.2.3.4;proto=https'})

    assert body['ip'] == '10.0.0.9'
    assert body['secure'] is False


# --- neither ---------------------------------------------------------------

def test_without_a_setting_proxy_headers_are_ignored_and_warn_once(caplog):
    client = _client()

    with caplog.at_level(logging.WARNING, logger='proxy'):
        first = _get(client, {'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https'})
        _get(client, {'X-Forwarded-For': '203.0.113.8'})

    assert first['ip'] == '10.0.0.9'
    assert first['secure'] is False
    assert len(caplog.records) == 1
    assert 'TRUSTED_PROXY_HOPS' in caplog.text


def test_without_a_setting_a_direct_request_logs_nothing(caplog):
    with caplog.at_level(logging.WARNING, logger='proxy'):
        _get(_client(), {})

    assert caplog.records == []


# --- validation ------------------------------------------------------------

def test_validate_refuses_both_settings(monkeypatch):
    monkeypatch.setattr(Config, 'TRUSTED_PROXY_HOPS', 1)
    monkeypatch.setattr(Config, 'CLIENT_IP_HEADER', 'True-Client-IP')

    with pytest.raises(ValueError, match='TRUSTED_PROXY_HOPS or CLIENT_IP_HEADER, not both'):
        Config.validate()


@pytest.mark.parametrize('header, message', [
    ('X-Forwarded-For', 'use TRUSTED_PROXY_HOPS'),
    ('forwarded', 'clients can set it'),
    ('True Client IP', 'must be a header name'),
])
def test_validate_refuses_a_header_that_cannot_be_trusted(monkeypatch, header, message):
    monkeypatch.setattr(Config, 'CLIENT_IP_HEADER', header)

    with pytest.raises(ValueError, match=message):
        Config.validate()


def test_validate_refuses_negative_hops(monkeypatch):
    monkeypatch.setattr(Config, 'TRUSTED_PROXY_HOPS', -1)

    with pytest.raises(ValueError, match='TRUSTED_PROXY_HOPS must be 0 or greater'):
        Config.validate()
