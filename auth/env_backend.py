"""
The env auth backend (AUTH_BACKEND=env) — the self-hosted default.

There is no users table: users come from `.env` as
``FLASK_USER_N=username:password:is_admin[:email]``, passwords hashed
with PBKDF2-SHA256 via Werkzeug. Sign-in is the classic form POST on
/login.
"""
import os
from functools import lru_cache

from flask import flash, redirect, render_template, request, url_for
from werkzeug.security import generate_password_hash, check_password_hash

from i18n import gettext as _

from auth.base import AuthBackend
from auth.session import start_session


def _is_bool_token(value: str) -> bool:
    return value.strip().lower() in {'true', 'false'}


def _looks_like_email(value: str) -> bool:
    value = value.strip()
    if '@' not in value or ' ' in value:
        return False
    _, _, domain = value.rpartition('@')
    return bool(domain and '.' in domain)


def hash_password(password: str) -> str:
    """
    Hash a password using PBKDF2-SHA256 with salt.

    Args:
        password: Plain text password

    Returns:
        Hashed password string
    """
    return generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)


@lru_cache(maxsize=None)
def _env_users() -> dict:
    """
    Get all users from environment variables.
    Results are cached to avoid repeated hashing.

    Environment variables should be in format:
        FLASK_USER_N=username:password:is_admin[:email]

    Example:
        FLASK_USER_1=admin:secretpass:true
        FLASK_USER_2=user:password:false

    An email configured here is trusted by the administrator who set it up,
    so no separate verification flag is needed.

    Returns:
        Dictionary mapping usernames to user data:
        {
            'username': {
                'password': 'hashed_password',
                'is_admin': bool
            }
        }
    """
    users = {}

    for key, value in os.environ.items():
        if key.startswith('FLASK_USER_'):
            try:
                # Extract parts from the value
                username, remainder = value.split(':', 1)
                parts = remainder.rsplit(':', 2)
                if len(parts) < 2:
                    raise ValueError

                email = None
                if len(parts) >= 3 and _is_bool_token(parts[-2]) and _looks_like_email(parts[-1]):
                    password = ':'.join(parts[:-2])
                    is_admin_str = parts[-2]
                    email = parts[-1].strip() or None
                else:
                    password = ':'.join(parts[:-1])
                    is_admin_str = parts[-1]

                users[username] = {
                    'password': hash_password(password),
                    'is_admin': is_admin_str.lower() == 'true',
                    'email': email,
                }
            except ValueError:
                # Handle cases where the value might not have enough parts
                print(f"Warning: Invalid user format in environment variable {key}")

    return users


def clear_users_cache():
    _env_users.cache_clear()


def verify_password(username: str, password: str) -> bool:
    """
    Verify username and password combination.

    Args:
        username: Username to verify
        password: Plain text password to check

    Returns:
        True if credentials are valid, False otherwise
    """
    user = _env_users().get(username)
    return bool(user) and check_password_hash(user['password'], password)


def is_admin(username: str) -> bool:
    """
    Check if user has admin privileges.

    Args:
        username: Username to check

    Returns:
        True if user is admin, False otherwise
    """
    user = _env_users().get(username)
    return bool(user) and user.get('is_admin', False)


class EnvBackend(AuthBackend):
    name = 'env'

    def list_users(self) -> dict:
        return _env_users()

    def login(self, request):
        if request.method == 'POST':
            username = request.form.get('username')
            password = request.form.get('password')
            user = _env_users().get(username) if verify_password(username, password) else None
            if user:
                start_session({
                    'username': username,
                    'is_admin': user.get('is_admin', False),
                    'email': user.get('email'),
                    'display_name': username,
                })
                flash(_('Logged in successfully'), 'success')
                return redirect(url_for('index'))
            flash(_('Invalid username or password'))
        return render_template('login.html', auth_backend=self.name)

    def session_user(self, username: str, snapshot: dict):
        user = _env_users().get(username)
        if not user:
            return None
        return {
            'is_admin': user.get('is_admin', False),
            'email': user.get('email'),
            'display_name': username,
        }

    def clear_caches(self):
        clear_users_cache()
