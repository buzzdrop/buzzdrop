"""
Authentication module for Buzzdrop.
Handles user management and authentication decorators.
"""
import os
import secrets
from functools import wraps, lru_cache
from typing import NamedTuple, Optional
from flask import g, session, flash, redirect, url_for, request
from werkzeug.security import generate_password_hash, check_password_hash

# Not `as _`: the decorators below unpack into `_`.
from i18n import gettext


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
def get_users() -> dict:
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


def verify_password(username: str, password: str) -> bool:
    """
    Verify username and password combination.
    
    Args:
        username: Username to verify
        password: Plain text password to check
    
    Returns:
        True if credentials are valid, False otherwise
    """
    users = get_users()
    user = users.get(username)
    
    if not user:
        return False
    
    return check_password_hash(user['password'], password)


def is_admin(username: str) -> bool:
    """
    Check if user has admin privileges.
    
    Args:
        username: Username to check
    
    Returns:
        True if user is admin, False otherwise
    """
    users = get_users()
    user = users.get(username)
    
    if not user:
        return False
    
    return user.get('is_admin', False)


def get_current_user() -> dict:
    """
    Get current logged-in user information.
    
    Returns:
        Dictionary with user info if logged in, None otherwise:
        {
            'username': str,
            'is_admin': bool
        }
    """
    username, user = _get_active_session_user()

    if not username:
        return None

    return {
        'username': username,
        'is_admin': user.get('is_admin', False),
        'email': user.get('email'),
    }


def _get_active_session_user():
    """Return the current session user if still configured, otherwise clear session."""
    username = session.get('username')

    if not username:
        return None, None

    users = get_users()
    user = users.get(username)

    if not user:
        logout_user()
        return None, None

    session['is_admin'] = user.get('is_admin', False)
    return username, user


def _redirect_to_login():
    flash(gettext('Please log in to access this page'))
    return redirect(url_for('login'))


def _refuse_login():
    return {'error': 'Login required', 'code': 'login_required'}, 401


def _session_required(f, refuse):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        username, _ = _get_active_session_user()
        if not username:
            return refuse()
        return f(*args, **kwargs)

    return decorated_function


def login_required(f):
    """
    Decorator to require login for a route.

    Usage::

        @app.route('/protected')
        @login_required
        def protected_route():
            pass
    """
    return _session_required(f, _redirect_to_login)


def json_login_required(f):
    """
    ``@login_required`` for routes the browser calls with ``fetch``.

    ``fetch`` follows a redirect, so the script would get the login page with
    a 200 and the flash would be spent on it. A missing session is a 401 JSON
    refusal instead, with no flash. Routes a form posts to keep
    ``@login_required``, even under ``/api/``.
    """
    return _session_required(f, _refuse_login)


def bearer_token():
    """
    The token of an ``Authorization: Bearer <token>`` header, or None when
    the request has no Bearer header. An empty token is ``''``, not None,
    so ``api_auth_required`` still rejects it.
    """
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[len('Bearer '):]
    return None


def api_auth_required(f):
    """
    Decorator for routes that accept both API token auth and session auth.

    Checks for an ``Authorization: Bearer <token>`` header first. If the header
    is present but the token is invalid, returns 401 JSON immediately (no
    session fallback). If no Authorization header is present, falls back to
    checking the session cookie like ``@json_login_required``: these routes
    are called with ``fetch`` or by API clients, never by a form.

    On success, sets ``flask.g.username`` so route handlers should read the
    authenticated user from ``g.username`` instead of ``session['username']``.

    Usage::

        @app.route('/upload', methods=['POST'])
        @api_auth_required
        def upload_file():
            username = g.username
            ...
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        raw_token = bearer_token()
        if raw_token is not None:
            from tokens import validate_api_token
            username = validate_api_token(raw_token)
            if not username:
                return {'error': 'Invalid or expired token'}, 401
            g.username = username
            return f(*args, **kwargs)

        # No Bearer header: require session login
        username, _ = _get_active_session_user()
        if not username:
            return _refuse_login()
        g.username = username
        return f(*args, **kwargs)

    return decorated_function



def admin_required(f):
    """
    Decorator to require admin privileges for a route.
    
    Usage:
        @app.route('/admin')
        @admin_required
        def admin_route():
            # Only accessible to admin users
            pass
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        username, user = _get_active_session_user()
        if not username:
            flash(gettext('Please log in to access this page'))
            return redirect(url_for('login'))

        if not user['is_admin']:
            flash(gettext('Admin access required'))
            return redirect(url_for('index'))
        
        return f(*args, **kwargs)
    
    return decorated_function


def login_user(username: str, password: str) -> bool:
    """
    Attempt to log in a user.
    
    Args:
        username: Username
        password: Plain text password
    
    Returns:
        True if login successful, False otherwise
    """
    if not verify_password(username, password):
        return False
    
    users = get_users()
    user = users.get(username)
    
    # Set session data — permanent so PERMANENT_SESSION_LIFETIME applies
    session.permanent = True
    session['username'] = username
    session['is_admin'] = user.get('is_admin', False)
    session['csrf_token'] = secrets.token_urlsafe(32)
    
    return True


def logout_user():
    """Log out the current user by clearing session."""
    session.pop('username', None)
    session.pop('is_admin', None)
    session.pop('csrf_token', None)
