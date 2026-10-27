"""
The backend-agnostic half of auth: the Flask session itself, the user
registry facade, and CSRF helpers. Which backend answers
``session_user`` and ``list_users`` is decided per request by
``get_auth_backend()`` — a session started under another backend than
the configured one is dropped.
"""
import os
import secrets

from flask import session


def backend_name() -> str:
    """'env' or 'clerk' (config.AUTH_BACKEND; env var outside app context)."""
    try:
        from flask import current_app
        return current_app.config.get('AUTH_BACKEND', 'env')
    except RuntimeError:
        return os.getenv('AUTH_BACKEND', 'env').strip().lower()


def get_users() -> dict:
    """
    The user registry of the configured backend, in the shape

        {'username': {'is_admin': bool, 'email': str|None, ...}}
    """
    from auth import get_auth_backend
    return get_auth_backend().list_users()


def _clear_user_caches():
    for name in ('env', 'clerk'):
        try:
            from auth import create_backend
            create_backend(name).clear_caches()
        except Exception:
            pass


get_users.cache_clear = _clear_user_caches


def start_session(profile: dict):
    """
    Start a session for a backend-authenticated profile. The snapshot
    kept on the session is what the backend's ``session_user`` re-reads
    every request.
    """
    from auth import get_auth_backend
    session.permanent = True
    session['username'] = profile['username']
    session['is_admin'] = profile.get('is_admin', False)
    session['csrf_token'] = secrets.token_urlsafe(32)
    session['auth_backend'] = get_auth_backend().name
    session['display_name'] = profile.get('display_name') or profile['username']
    session['user_snapshot'] = {
        'email': profile.get('email'),
        'display_name': profile.get('display_name'),
    }


def logout_user():
    """Log out the current user by clearing session."""
    session.pop('username', None)
    session.pop('is_admin', None)
    session.pop('csrf_token', None)
    session.pop('auth_backend', None)
    session.pop('display_name', None)
    session.pop('user_snapshot', None)


def active_session_user():
    """Return the current session user if still valid, otherwise clear session."""
    username = session.get('username')

    if not username:
        return None, None

    from auth import get_auth_backend
    backend = get_auth_backend()
    # Sessions written before the backend split carry no marker; they
    # belong to whichever backend is configured now.
    if session.setdefault('auth_backend', backend.name) != backend.name:
        logout_user()
        return None, None

    user = backend.session_user(username, session.get('user_snapshot') or {})
    if user is None:
        logout_user()
        return None, None

    session['is_admin'] = user.get('is_admin', False)
    return username, user


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
    username, user = active_session_user()

    if not username:
        return None

    return {
        'username': username,
        'is_admin': user.get('is_admin', False),
        'email': user.get('email'),
        'display_name': user.get('display_name') or username,
    }
