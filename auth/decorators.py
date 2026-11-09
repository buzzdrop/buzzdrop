"""
Route guards, backend-agnostic: they ask ``active_session_user`` (the
session), not any particular user store.
"""
from functools import wraps

from flask import g, session, flash, redirect, url_for, request

# Not `as _`: the decorators below unpack into `_`.
from i18n import gettext

from auth.session import active_session_user


def _redirect_to_login():
    flash(gettext('Please log in to access this page'))
    return redirect(url_for('login'))


def _refuse_login():
    return {'error': 'Login required', 'code': 'login_required'}, 401


def _session_required(f, refuse):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        username, _ = active_session_user()
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
        username, _ = active_session_user()
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
        username, user = active_session_user()
        if not username:
            flash(gettext('Please log in to access this page'))
            return redirect(url_for('login'))

        if not user['is_admin']:
            flash(gettext('Admin access required'))
            return redirect(url_for('index'))

        return f(*args, **kwargs)

    return decorated_function
