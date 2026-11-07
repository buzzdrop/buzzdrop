"""
The first admin from ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_EMAIL, and the
startup checks on users (#379, #421).
"""
import os
import subprocess
import sys

import pytest

from auth import get_users, validate_users, verify_password

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def users_env(monkeypatch):
    """Only the users a test sets: no FLASK_USER_N, no ADMIN_*."""
    for key in [k for k in os.environ if k.startswith(('FLASK_USER_', 'ADMIN_'))]:
        monkeypatch.delenv(key)
    get_users.cache_clear()
    yield monkeypatch
    monkeypatch.undo()
    get_users.cache_clear()


def test_admin_vars_make_one_admin_user(users_env):
    users_env.setenv('ADMIN_USERNAME', 'admin')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('ADMIN_EMAIL', 'admin@example.test')

    users = get_users()

    assert set(users) == {'admin'}
    assert users['admin']['is_admin'] is True
    assert users['admin']['email'] == 'admin@example.test'
    assert verify_password('admin', 'chosen-password')


def test_flask_user_n_still_adds_more_users(users_env):
    users_env.setenv('ADMIN_USERNAME', 'admin')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('FLASK_USER_1', 'alice:alice-pass:false')

    users = get_users()

    assert set(users) == {'admin', 'alice'}
    assert users['alice']['is_admin'] is False
    validate_users(is_production=True)


def test_an_admin_vars_clash_with_flask_user_n_is_a_startup_error(users_env):
    users_env.setenv('ADMIN_USERNAME', 'alice')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('FLASK_USER_3', 'alice:alice-pass:false')

    with pytest.raises(ValueError, match="ADMIN_USERNAME 'alice' is also the user in FLASK_USER_3"):
        validate_users(is_production=False)


@pytest.mark.parametrize('username, password, missing', [
    ('admin', None, 'ADMIN_PASSWORD'),
    ('admin', '', 'ADMIN_PASSWORD'),
    ('admin', '   ', 'ADMIN_PASSWORD'),
    (None, 'chosen-password', 'ADMIN_USERNAME'),
    ('', 'chosen-password', 'ADMIN_USERNAME'),
])
def test_production_refuses_a_half_set_admin(users_env, username, password, missing):
    users_env.setenv('FLASK_USER_1', 'boss:boss-pass:true')
    if username is not None:
        users_env.setenv('ADMIN_USERNAME', username)
    if password is not None:
        users_env.setenv('ADMIN_PASSWORD', password)

    with pytest.raises(ValueError, match=f'{missing} must be set and not empty'):
        validate_users(is_production=True)


def test_an_admin_vars_clash_ignores_spaces_around_the_flask_user_n_name(users_env):
    users_env.setenv('ADMIN_USERNAME', 'alice')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('FLASK_USER_3', 'alice :alice-pass:false')

    with pytest.raises(ValueError, match="ADMIN_USERNAME 'alice' is also the user in FLASK_USER_3"):
        validate_users(is_production=False)


@pytest.mark.parametrize('username, password, empty', [
    ('', '', 'ADMIN_USERNAME'),
    ('  ', ' ', 'ADMIN_USERNAME'),
    (None, '', 'ADMIN_PASSWORD'),
    ('', None, 'ADMIN_USERNAME'),
])
def test_production_refuses_admin_vars_that_are_set_but_empty(users_env, username, password, empty):
    # A FLASK_USER_N admin exists, so only the empty vars can stop startup.
    users_env.setenv('FLASK_USER_1', 'boss:boss-pass:true')
    if username is not None:
        users_env.setenv('ADMIN_USERNAME', username)
    if password is not None:
        users_env.setenv('ADMIN_PASSWORD', password)

    with pytest.raises(ValueError, match=f'{empty} is set but empty'):
        validate_users(is_production=True)


def test_outside_production_empty_admin_vars_are_ignored(users_env):
    users_env.setenv('ADMIN_USERNAME', '')
    users_env.setenv('ADMIN_PASSWORD', '')

    validate_users(is_production=False)


def test_outside_production_a_half_set_admin_is_ignored(users_env):
    users_env.setenv('ADMIN_USERNAME', 'admin')
    users_env.setenv('ADMIN_PASSWORD', '')

    validate_users(is_production=False)

    assert 'admin' not in get_users()


def test_production_refuses_to_run_without_any_admin(users_env):
    users_env.setenv('FLASK_USER_1', 'alice:alice-pass:false')

    with pytest.raises(ValueError, match='No admin user: set ADMIN_USERNAME and ADMIN_PASSWORD'):
        validate_users(is_production=True)


def test_a_flask_user_n_admin_is_enough_in_production(users_env):
    # The official deployment's setup: no ADMIN_* at all.
    users_env.setenv('FLASK_USER_1', 'boss:boss-pass:true')

    validate_users(is_production=True)


def test_development_runs_without_any_admin(users_env):
    validate_users(is_production=False)


def test_an_admin_email_that_is_not_an_address_is_a_startup_error(users_env):
    users_env.setenv('ADMIN_USERNAME', 'admin')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('ADMIN_EMAIL', 'not-an-address')

    with pytest.raises(ValueError, match='ADMIN_EMAIL must be an email address'):
        validate_users(is_production=False)


def test_a_malformed_flask_user_n_stays_a_warning(users_env, capsys):
    users_env.setenv('ADMIN_USERNAME', 'admin')
    users_env.setenv('ADMIN_PASSWORD', 'chosen-password')
    users_env.setenv('FLASK_USER_1', 'no-colons-here')

    validate_users(is_production=True)

    assert 'Invalid user format in environment variable FLASK_USER_1' in capsys.readouterr().out


def _start_production(tmp_path, **env):
    """Import the app in a fresh production process; return the result."""
    base = {
        k: v for k, v in os.environ.items()
        if not k.startswith(('FLASK_USER_', 'ADMIN_', 'FLASK_ENV'))
    }
    base.update({
        'FLASK_ENV': 'production',
        'FLASK_SECRET_KEY': 'session-secret-of-at-least-32-chars',
        'TOKEN_HASH_SECRET': 'token-hash-secret-of-at-least-32-chars',
        'DATABASE_URL': f'sqlite:///{tmp_path}/startup.db',
        'UPLOAD_FOLDER': str(tmp_path / 'uploads'),
        'EXPIRY_SWEEP_INTERVAL_SECONDS': '0',
        'SMTP_HOST': '',
    })
    base.update(env)
    # No .env: a developer's own users would leak into the check.
    return subprocess.run(
        [sys.executable, '-c',
         'import dotenv; dotenv.load_dotenv = lambda *a, **k: False; import app'],
        env=base, capture_output=True, text=True, cwd=ROOT)


def test_production_starts_with_the_admin_vars(tmp_path):
    result = _start_production(tmp_path, ADMIN_USERNAME='admin', ADMIN_PASSWORD='chosen-password')

    assert result.returncode == 0, result.stderr


def test_production_startup_names_a_missing_admin_password(tmp_path):
    # What a Render deploy with a blank ADMIN_PASSWORD prompt looks like.
    result = _start_production(tmp_path, ADMIN_USERNAME='admin')

    assert result.returncode != 0
    assert 'ADMIN_PASSWORD must be set and not empty' in result.stderr
