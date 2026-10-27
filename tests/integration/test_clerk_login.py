"""Integration tests for AUTH_BACKEND=clerk: /login, the session bridge,
logout, and the CSP room clerk.js gets."""
import pytest

import auth.clerk_backend as clerk_auth
from auth import get_current_user

FAPI = 'https://clerk.test.example.com'

CLERK_CONFIG = {
    'AUTH_BACKEND': 'clerk',
    'CLERK_FRONTEND_API_URL': FAPI,
    'CLERK_SECRET_KEY': 'sk_test_x',
    'CLERK_PUBLISHABLE_KEY': 'pk_test_x',
    'CLERK_JS_VERSION': '5',
}


@pytest.fixture
def clerk_app(app):
    original = {name: app.config.get(name) for name in CLERK_CONFIG}
    app.config.update(CLERK_CONFIG)
    yield app
    app.config.update(original)


@pytest.fixture
def clerk_profile(monkeypatch):
    profile = {
        'username': 'user_2abc',
        'email': 'bee@example.com',
        'display_name': 'bee',
    }
    monkeypatch.setattr(
        clerk_auth, 'session_user', lambda token: profile if token == 'good' else None)
    return profile


def test_login_page_mounts_clerk(client, clerk_app):
    response = client.get('/login')
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'id="clerk-sign-in"' in html
    assert f'{FAPI}/npm/@clerk/clerk-js@5/dist/clerk.browser.js' in html
    assert 'data-clerk-publishable-key="pk_test_x"' in html
    assert 'name="username"' not in html  # no env-backend form


def test_login_page_csp_admits_clerk(client, clerk_app):
    csp = client.get('/login').headers['Content-Security-Policy']
    assert f'script-src \'self\' {FAPI}' in csp
    assert FAPI in csp.split('connect-src')[1].split(';')[0]
    assert 'clerk-telemetry.com' in csp
    assert 'img.clerk.com' in csp
    assert 'challenges.cloudflare.com' in csp
    assert 'worker-src blob:' in csp


def test_env_login_page_keeps_baseline_csp(client):
    csp = client.get('/login').headers['Content-Security-Policy']
    assert 'clerk-telemetry.com' not in csp
    assert 'worker-src' not in csp
    assert 'clerk.accounts.dev' not in csp


def test_login_post_env_form_still_works(client):
    response = client.post(
        '/login', data={'username': 'testuser', 'password': 'password'})
    assert response.status_code == 302


def test_bridge_404_under_env_backend(client):
    response = client.post(
        '/auth/session', json={'token': 'good'},
        headers={'X-Requested-With': 'XMLHttpRequest'})
    assert response.status_code == 404


def test_bridge_requires_xhr_header(client, clerk_app, clerk_profile):
    response = client.post('/auth/session', json={'token': 'good'})
    assert response.status_code == 400
    assert response.get_json()['code'] == 'invalid_request'


def test_bridge_rejects_bad_token(client, clerk_app, clerk_profile):
    response = client.post(
        '/auth/session', json={'token': 'bad'},
        headers={'X-Requested-With': 'XMLHttpRequest'})
    assert response.status_code == 401
    assert response.get_json()['code'] == 'auth_failed'


def test_bridge_establishes_session(client, clerk_app, clerk_profile):
    response = client.post(
        '/auth/session', json={'token': 'good'},
        headers={'X-Requested-With': 'XMLHttpRequest'})
    assert response.status_code == 200
    assert response.get_json() == {'ok': True, 'redirect': '/'}

    with client.session_transaction() as session:
        assert session['username'] == 'user_2abc'
        assert session['auth_backend'] == 'clerk'
        assert session['display_name'] == 'bee'
        assert session['user_snapshot']['email'] == 'bee@example.com'

    with client.application.test_request_context('/'):
        from flask import session as flask_session
        flask_session.update({
            'username': 'user_2abc',
            'auth_backend': 'clerk',
            'display_name': 'bee',
            'user_snapshot': {'email': 'bee@example.com', 'display_name': 'bee'},
        })
        user = get_current_user()
        assert user['username'] == 'user_2abc'
        assert user['email'] == 'bee@example.com'
        assert user['display_name'] == 'bee'


def test_index_accessible_after_bridge(client, clerk_app, clerk_profile):
    client.post(
        '/auth/session', json={'token': 'good'},
        headers={'X-Requested-With': 'XMLHttpRequest'})
    assert client.get('/').status_code == 200


def test_clerk_logout_redirects_for_signout(client, clerk_app, clerk_profile):
    client.post(
        '/auth/session', json={'token': 'good'},
        headers={'X-Requested-With': 'XMLHttpRequest'})
    with client.session_transaction() as session:
        csrf = session['csrf_token']
    response = client.post('/logout', data={'csrf_token': csrf})
    assert response.status_code == 302
    assert '/login?signed_out=1' in response.headers['Location']


def test_env_logout_redirects_to_index(client):
    client.post(
        '/login', data={'username': 'testuser', 'password': 'password'})
    with client.session_transaction() as session:
        csrf = session['csrf_token']
    response = client.post('/logout', data={'csrf_token': csrf})
    assert response.status_code == 302
    assert 'signed_out' not in response.headers['Location']
