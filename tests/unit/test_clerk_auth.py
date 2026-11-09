"""Unit tests for the Clerk auth backend (AUTH_BACKEND=clerk)."""
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

import auth.clerk_backend as clerk_auth

FAPI = 'https://clerk.test.example.com'

CLERK_CONFIG = {
    'AUTH_BACKEND': 'clerk',
    'CLERK_FRONTEND_API_URL': FAPI,
    'CLERK_SECRET_KEY': 'sk_test_x',
    'CLERK_PUBLISHABLE_KEY': 'pk_test_x',
    'CLERK_AUTHORIZED_PARTIES': frozenset(),
    'CLERK_ADMIN_USERS': frozenset(),
    'CLERK_ALLOWED_USERS': frozenset(),
}


@pytest.fixture
def rsa_keys():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return key, public_pem


@pytest.fixture
def clerk_config(app, rsa_keys):
    """The app configured for AUTH_BACKEND=clerk with a static JWT key."""
    private_key, public_pem = rsa_keys
    config = dict(CLERK_CONFIG)
    config['CLERK_JWT_KEY'] = public_pem
    original = {name: app.config.get(name) for name in config}
    app.config.update(config)
    yield private_key
    app.config.update(original)


def make_token(private_key, **overrides):
    claims = {
        'iss': FAPI,
        'sub': 'user_2abc',
        'azp': 'https://buzzdrop.test.example.com',
        'iat': int(time.time()),
        'exp': int(time.time()) + 60,
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm='RS256')


def clerk_user(user_id='user_2abc', email='bee@example.com', **overrides):
    user = {
        'id': user_id,
        'username': 'bee',
        'first_name': None,
        'last_name': None,
        'primary_email_address_id': 'em_1',
        'email_addresses': [{'id': 'em_1', 'email_address': email}],
    }
    user.update(overrides)
    return user


class TestVerifySessionToken:
    def test_valid_token_returns_claims(self, app, clerk_config):
        claims = clerk_auth.verify_session_token(make_token(clerk_config))
        assert claims['sub'] == 'user_2abc'

    def test_wrong_issuer_rejected(self, app, clerk_config):
        token = make_token(clerk_config, iss='https://evil.clerk.accounts.dev')
        assert clerk_auth.verify_session_token(token) is None

    def test_expired_rejected(self, app, clerk_config):
        token = make_token(
            clerk_config,
            iat=int(time.time()) - 120,
            exp=int(time.time()) - 60,
        )
        assert clerk_auth.verify_session_token(token) is None

    def test_garbage_rejected(self, app, clerk_config):
        assert clerk_auth.verify_session_token('not-a-jwt') is None
        assert clerk_auth.verify_session_token(None) is None

    def test_missing_sub_rejected(self, app, clerk_config):
        token = make_token(clerk_config)
        token = jwt.encode(
            {'iss': FAPI, 'exp': int(time.time()) + 60},
            clerk_config, algorithm='RS256')
        assert clerk_auth.verify_session_token(token) is None

    def test_azp_checked_when_parties_configured(self, app, clerk_config):
        app.config['CLERK_AUTHORIZED_PARTIES'] = frozenset(
            {'https://buzzdrop.test.example.com'})
        assert clerk_auth.verify_session_token(make_token(clerk_config)) is not None
        bad = make_token(clerk_config, azp='https://evil.example.com')
        assert clerk_auth.verify_session_token(bad) is None


class TestSessionUser:
    def test_profile_from_token_and_backend_user(
            self, app, clerk_config, monkeypatch):
        monkeypatch.setattr(
            clerk_auth, 'fetch_user', lambda uid: clerk_user(uid))
        profile = clerk_auth.session_user(make_token(clerk_config))
        assert profile == {
            'username': 'user_2abc',
            'email': 'bee@example.com',
            'display_name': 'bee',
            'is_admin': False,
        }

    def test_unknown_backend_user_rejected(self, app, clerk_config, monkeypatch):
        monkeypatch.setattr(clerk_auth, 'fetch_user', lambda uid: None)
        assert clerk_auth.session_user(make_token(clerk_config)) is None

    def test_allowlist_excludes_strangers(self, app, clerk_config, monkeypatch):
        app.config['CLERK_ALLOWED_USERS'] = frozenset({'other@example.com'})
        monkeypatch.setattr(
            clerk_auth, 'fetch_user', lambda uid: clerk_user(uid))
        assert clerk_auth.session_user(make_token(clerk_config)) is None

    def test_allowlist_admits_by_id_or_email(
            self, app, clerk_config, monkeypatch):
        monkeypatch.setattr(
            clerk_auth, 'fetch_user', lambda uid: clerk_user(uid))
        app.config['CLERK_ALLOWED_USERS'] = frozenset({'user_2abc'})
        assert clerk_auth.session_user(make_token(clerk_config)) is not None
        app.config['CLERK_ALLOWED_USERS'] = frozenset({'bee@example.com'})
        assert clerk_auth.session_user(make_token(clerk_config)) is not None

    def test_admin_flag_by_id_or_email(self, app, clerk_config):
        assert not clerk_auth.is_admin('user_2abc', 'bee@example.com')
        app.config['CLERK_ADMIN_USERS'] = frozenset({'bee@example.com'})
        assert clerk_auth.is_admin('user_2abc', 'bee@example.com')
        app.config['CLERK_ADMIN_USERS'] = frozenset({'user_2abc'})
        assert clerk_auth.is_admin('user_2abc', 'nobody@example.com')


class TestUserFields:
    def test_primary_email_picked(self):
        user = clerk_user(email='first@example.com')
        user['email_addresses'].append(
            {'id': 'em_2', 'email_address': 'second@example.com'})
        assert clerk_auth.primary_email(user) == 'first@example.com'

    def test_display_name_prefers_username_then_email(self):
        assert clerk_auth.display_name(clerk_user()) == 'bee'
        assert clerk_auth.display_name(
            clerk_user(username=None)) == 'bee@example.com'

    def test_list_users_shape(self, app, clerk_config, monkeypatch):
        monkeypatch.setattr(
            clerk_auth, '_backend_get',
            lambda path: [clerk_user()] if path.startswith('/users') else None)
        clerk_auth.clear_users_cache()
        users = clerk_auth.list_users()
        assert users == {'user_2abc': {
            'is_admin': False,
            'email': 'bee@example.com',
            'display_name': 'bee',
        }}
