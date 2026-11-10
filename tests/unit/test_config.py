"""Unit tests for configuration validation and session cookie hardening."""
import os
import subprocess
import sys

import pytest

from config import Config, DevelopmentConfig, ProductionConfig, _looks_like_placeholder


@pytest.fixture
def s3_config(monkeypatch):
    """Config patched to STORAGE_BACKEND=s3 with real-looking credentials."""
    monkeypatch.setattr(Config, 'STORAGE_BACKEND', 's3')
    monkeypatch.setattr(Config, 'S3_BUCKET', 'real-bucket')
    monkeypatch.setattr(Config, 'S3_ACCESS_KEY', 'AKIAIOSFODNN7X71REAL')
    monkeypatch.setattr(Config, 'S3_SECRET_KEY', 'wJalrXUtnFEMI-K7MDENG-bPxRfiCY-real')


def test_session_cookie_defaults(app):
    assert app.config['SESSION_COOKIE_HTTPONLY'] is True
    assert app.config['SESSION_COOKIE_SAMESITE'] == 'Lax'
    assert app.config['PERMANENT_SESSION_LIFETIME'] == 8 * 3600


def test_session_cookie_secure_env_split():
    # Development defaults to non-Secure (plain HTTP dev); production
    # and the base config default to Secure.
    assert Config.SESSION_COOKIE_SECURE is True
    assert DevelopmentConfig.SESSION_COOKIE_SECURE is False
    assert ProductionConfig.SESSION_COOKIE_SECURE is True


def test_max_content_length_aligned_with_env_example(app):
    # .env.example ships MAX_CONTENT_LENGTH=104857600 — the code default
    # must match (100 MB).
    assert app.config['MAX_CONTENT_LENGTH'] == 100 * 1024 * 1024


def test_validate_requires_token_hash_secret_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'session-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', None)

    with pytest.raises(ValueError, match='TOKEN_HASH_SECRET must be set in production'):
        Config.validate()


def test_validate_rejects_token_hash_secret_equal_to_secret_key(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'shared-secret-of-at-least-32-chars')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'shared-secret-of-at-least-32-chars')

    with pytest.raises(ValueError, match='must differ from FLASK_SECRET_KEY'):
        Config.validate()


SESSION_SECRET = 'session-secret-of-at-least-32-chars'
TOKEN_SECRET = 'token-hash-secret-of-at-least-32-chars'


def test_validate_allows_distinct_token_hash_secret_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', SESSION_SECRET)
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', TOKEN_SECRET)

    Config.validate()


@pytest.mark.parametrize('name, attr', [
    ('FLASK_SECRET_KEY', 'SECRET_KEY'),
    ('TOKEN_HASH_SECRET', 'TOKEN_HASH_SECRET'),
])
def test_validate_rejects_a_secret_shorter_than_32_in_production(monkeypatch, name, attr):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', SESSION_SECRET)
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', TOKEN_SECRET)
    monkeypatch.setattr(Config, attr, 'x' * 31)

    with pytest.raises(ValueError, match=f'{name} must be at least 32 characters.*openssl rand -hex 32'):
        Config.validate()


def test_validate_names_the_length_before_equal_short_secrets(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'shared-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'shared-secret')

    with pytest.raises(ValueError, match='FLASK_SECRET_KEY must be at least 32 characters'):
        Config.validate()


def test_validate_accepts_secrets_of_exactly_32_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'a' * 32)
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'b' * 32)

    Config.validate()


def test_validate_rejects_the_env_example_secret_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'your-secret-key-here-change-this-in-production')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', TOKEN_SECRET)

    with pytest.raises(ValueError, match='FLASK_SECRET_KEY looks like the .env.example placeholder'):
        Config.validate()


def test_validate_allows_short_secrets_outside_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'development')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'short')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'short-too')

    Config.validate()


def test_validate_allows_token_secret_fallback_outside_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'development')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'session-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', None)

    Config.validate()


@pytest.mark.parametrize('placeholder', [
    'youraccesskey', 'your-access-key', 'changeme', 'change-me',
    '<access-key>', 'my-example-bucket', 'bucketname',
])
def test_validate_rejects_placeholder_s3_values(s3_config, monkeypatch, placeholder):
    monkeypatch.setattr(Config, 'S3_ACCESS_KEY', placeholder)

    with pytest.raises(ValueError, match='placeholder'):
        Config.validate()


def test_validate_accepts_real_s3_credentials(s3_config):
    Config.validate()


def test_validate_still_requires_all_s3_vars(s3_config, monkeypatch):
    monkeypatch.setattr(Config, 'S3_SECRET_KEY', None)

    with pytest.raises(ValueError, match='S3 configuration incomplete'):
        Config.validate()


def test_validate_rejects_samesite_none_without_secure(monkeypatch):
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SAMESITE', 'None')
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SECURE', False)

    with pytest.raises(ValueError, match='SESSION_COOKIE_SAMESITE'):
        Config.validate()


def test_validate_rejects_invalid_samesite(monkeypatch):
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SAMESITE', 'bogus')

    with pytest.raises(ValueError, match='SESSION_COOKIE_SAMESITE'):
        Config.validate()


@pytest.mark.parametrize('value,expected', [
    ('youraccesskey', True),
    ('YOUR-SECRET', True),
    ('changeme', True),
    ('<key>', True),
    ('bucketname', True),
    ('example-creds', True),
    ('AKIAIOSFODNN7X7REAL', False),
    ('prod-buzzdrop-uploads', False),
    (None, False),
    ('', False),
])
def test_looks_like_placeholder(value, expected):
    assert _looks_like_placeholder(value) is expected


@pytest.mark.parametrize('value', ['', '   '])
def test_empty_source_code_url_falls_back_to_the_upstream_repository(value):
    # Config reads the environment at import time, so import it afresh in a
    # child process; an empty value must not render the footer link as href="".
    env = {**os.environ, 'SOURCE_CODE_URL': value}
    result = subprocess.run(
        [sys.executable, '-c', 'from config import Config; print(Config.SOURCE_CODE_URL)'],
        env=env, capture_output=True, text=True, check=True,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    assert result.stdout.strip() == 'https://github.com/buzzdrop/buzzdrop'


@pytest.mark.parametrize('env_value, expected', [(None, 'False'), ('false', 'False'), ('true', 'True')])
def test_ephemeral_instance_is_off_unless_set(env_value, expected):
    env = {k: v for k, v in os.environ.items() if k != 'EPHEMERAL_INSTANCE'}
    if env_value is not None:
        env['EPHEMERAL_INSTANCE'] = env_value
    result = subprocess.run(
        [sys.executable, '-c', 'from config import Config; print(Config.EPHEMERAL_INSTANCE)'],
        env=env, capture_output=True, text=True, check=True,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    assert result.stdout.strip() == expected


@pytest.mark.parametrize('value', ['https://buzzdrop.io/how-it-works/', ''])
def test_validate_refuses_the_replaced_explainer_url(monkeypatch, value):
    # EXPLAINER_URL gave way to WEBSITE_URL (#371); a deployment still
    # setting it must hear so, not lose its setting silently.
    monkeypatch.setenv('EXPLAINER_URL', value)
    with pytest.raises(ValueError, match='WEBSITE_URL'):
        Config.validate()


# --- client IP behind a proxy (proxy.py, #422) ----------------------------

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


def test_runtime_config_check_passes_on_the_shipped_config(app):
    # Every key the routes read mid-request is present after from_object.
    from config import check_runtime_config, REQUIRED_RUNTIME_KEYS
    check_runtime_config(app.config)
    for key in REQUIRED_RUNTIME_KEYS:
        assert key in app.config


def test_runtime_config_check_names_missing_keys():
    # A config class (or a test app) missing a key the routes read would
    # die as a 500 on first use; the startup check names it instead (#220).
    from config import check_runtime_config, REQUIRED_RUNTIME_KEYS
    loaded = {key: True for key in REQUIRED_RUNTIME_KEYS}
    del loaded['KEY_RELEASE_BURN_ON_LOCKOUT']

    with pytest.raises(ValueError, match='KEY_RELEASE_BURN_ON_LOCKOUT'):
        check_runtime_config(loaded)
