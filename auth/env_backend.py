"""
The env auth backend (AUTH_BACKEND=env) — the self-hosted default.

There is no users table: the first admin comes from ``ADMIN_USERNAME``,
``ADMIN_PASSWORD`` and an optional ``ADMIN_EMAIL``; more users come from
`.env` as ``FLASK_USER_N=username:password:is_admin[:email]``, passwords
hashed with PBKDF2-SHA256 via Werkzeug. Sign-in is the classic form POST
on /login.
"""
import os
from functools import lru_cache
from typing import NamedTuple, Optional
from urllib.parse import urlsplit

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


_ADMIN_VARS = ('ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_EMAIL')


def _admin_vars():
    """The ADMIN_* values, each stripped, or None when unset or empty."""
    return tuple((os.getenv(name) or '').strip() or None for name in _ADMIN_VARS)


class _UserEntry(NamedTuple):
    """One parsed FLASK_USER_N variable."""
    key: str
    username: str
    password: str
    is_admin: bool
    email: Optional[str]


def _user_record(password: str, is_admin: bool, email: Optional[str]) -> dict:
    return {'password': hash_password(password), 'is_admin': is_admin, 'email': email}


def _flask_user_entries():
    """
    Parse every FLASK_USER_N variable.

    Returns:
        List of _UserEntry. A malformed variable is skipped with a warning.
    """
    entries = []
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

                entries.append(_UserEntry(key, username, password, is_admin_str.lower() == 'true', email))
            except ValueError:
                # Handle cases where the value might not have enough parts
                print(f"Warning: Invalid user format in environment variable {key}")
    return entries


def validate_users(is_production: bool) -> None:
    """
    Refuse a user setup the app can't run with (#379). Called at startup.

    Everywhere: an ADMIN_USERNAME that a FLASK_USER_N also uses, and an
    ADMIN_EMAIL that isn't an address. In production also: ADMIN_USERNAME
    and ADMIN_PASSWORD set only half or empty, and no admin at all.
    Outside production a half-set admin is ignored with a warning.

    Raises:
        ValueError: naming the variable to fix.
    """
    username, password, email = _admin_vars()
    entries = _flask_user_entries()

    if email and not _looks_like_email(email):
        raise ValueError("ADMIN_EMAIL must be an email address")
    if username:
        for entry in entries:
            # Stripped, so 'admin ' can't pass as a second 'admin'.
            if entry.username.strip() == username:
                raise ValueError(
                    f"ADMIN_USERNAME '{username}' is also the user in {entry.key}: "
                    "pick a different name for one of them")

    if bool(username) != bool(password):
        present, missing = (('ADMIN_USERNAME', 'ADMIN_PASSWORD') if username
                            else ('ADMIN_PASSWORD', 'ADMIN_USERNAME'))
        if is_production:
            raise ValueError(
                f"{missing} must be set and not empty when {present} is set")
        print(f"Warning: {missing} is not set, so no admin is created from ADMIN_*")

    if is_production:
        # Set but blank on both sides, e.g. a deploy's skipped prompts.
        for name in _ADMIN_VARS[:2]:
            value = os.getenv(name)
            if value is not None and not value.strip():
                raise ValueError(
                    f"{name} is set but empty: give it a value, or remove "
                    "ADMIN_USERNAME and ADMIN_PASSWORD")

    if is_production and not (username and password) and not any(
            entry.is_admin for entry in entries):
        raise ValueError(
            "No admin user: set ADMIN_USERNAME and ADMIN_PASSWORD "
            "(or a FLASK_USER_N with is_admin=true)")


@lru_cache(maxsize=None)
def _env_users() -> dict:
    """
    Get all users from environment variables.
    Results are cached to avoid repeated hashing.

    The first admin comes from ADMIN_USERNAME, ADMIN_PASSWORD and an
    optional ADMIN_EMAIL; more users from variables in the format:
        FLASK_USER_N=username:password:is_admin[:email]

    Example:
        ADMIN_USERNAME=admin
        ADMIN_PASSWORD=secretpass
        FLASK_USER_1=user:password:false

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

    for entry in _flask_user_entries():
        users[entry.username] = _user_record(entry.password, entry.is_admin, entry.email)

    # validate_users refuses a clash at startup; ADMIN_* wins otherwise.
    username, password, email = _admin_vars()
    if username and password:
        users[username] = _user_record(password, True, email)

    return users


def clear_users_cache():
    _env_users.cache_clear()


# Unknown usernames pay the same PBKDF2 cost as known ones: verify_password
# hashes against this throwaway hash instead of skipping the check, so the
# response time doesn't reveal which usernames exist (#465).
_DUMMY_PASSWORD_HASH = hash_password('placeholder-dummy')


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
    matched = check_password_hash(
        user['password'] if user else _DUMMY_PASSWORD_HASH, password)
    return matched and bool(user)


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


def _local_path(target):
    """``target`` when it is a path on this site, else None (no open redirect)."""
    if (not target or not target.startswith('/') or target.startswith('//')
            or '\\' in target or any(ord(char) < 0x20 or ord(char) == 0x7f for char in target)):
        return None
    parts = urlsplit(target)
    if parts.scheme or parts.netloc:
        return None
    return target


class EnvBackend(AuthBackend):
    name = 'env'

    def list_users(self) -> dict:
        return _env_users()

    def validate(self, is_production: bool) -> None:
        validate_users(is_production)

    def login(self, request):
        # Where to go once signed in: the local path / sent along, else
        # home. The form posts back to this URL, so next survives the POST.
        after_login = _local_path(request.args.get('next')) or url_for('index')
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
                return redirect(after_login)
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
