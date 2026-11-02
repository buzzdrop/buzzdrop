"""
The Clerk auth backend (AUTH_BACKEND=clerk).

The browser signs in through clerk.js; the resulting session JWT is
POSTed to /auth/session, which verifies it here and exchanges it for an
ordinary Flask session — decorators, CSRF and ``g.username`` stay
backend-agnostic. Clerk remains the user store: profile fields come
from the Backend API (CLERK_SECRET_KEY), privileges from
CLERK_ADMIN_USERS, and admission from CLERK_ALLOWED_USERS.

Buzzdrop usernames under this backend are Clerk user ids
(``user_…``): stable across email changes, which keeps ``uploaded_by``,
``created_by`` and API-token ownership pointing at the right account.
"""
import json
import time
import urllib.error
import urllib.request

import jwt
from jwt import PyJWKClient
from flask import current_app, g, render_template

from auth.base import AuthBackend

_BACKEND_API_BASE = 'https://api.clerk.com/v1'
_BACKEND_API_TIMEOUT = 10
_USER_LIST_TTL_SECONDS = 60

_jwks_clients = {}
_user_list_cache = {'at': 0.0, 'users': None}


def _cfg(name, default=None):
    try:
        return current_app.config.get(name, default)
    except RuntimeError:
        from config import get_config
        return getattr(get_config(), name, default)


def frontend_api() -> str:
    """The Clerk Frontend API origin, e.g. ``https://clerk.example.com``."""
    return _cfg('CLERK_FRONTEND_API_URL', '') or ''


def _jwks_client() -> PyJWKClient:
    url = frontend_api()
    if url not in _jwks_clients:
        _jwks_clients[url] = PyJWKClient(f'{url}/.well-known/jwks.json')
    return _jwks_clients[url]


def verify_session_token(token: str):
    """
    Verify a Clerk session JWT and return its claims, or None.

    Signed RS256 by the instance's private key: the public half comes
    from CLERK_JWT_KEY (a PEM, verification without network) or the
    Frontend API's JWKS endpoint (fetched once, cached by PyJWKClient).
    ``iss`` must be the configured Frontend API origin, and ``azp`` —
    when CLERK_AUTHORIZED_PARTIES is set — must be one of them.
    """
    if not token or not frontend_api():
        return None
    try:
        jwt_key = _cfg('CLERK_JWT_KEY')
        key = jwt_key or _jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=['RS256'], issuer=frontend_api())
    except (jwt.PyJWTError, jwt.exceptions.PyJWKClientError, KeyError):
        return None

    parties = _cfg('CLERK_AUTHORIZED_PARTIES') or frozenset()
    if parties and claims.get('azp') not in parties:
        return None
    return claims if claims.get('sub') else None


def _backend_get(path: str):
    """GET the Clerk Backend API; parsed JSON or None on any failure."""
    secret_key = _cfg('CLERK_SECRET_KEY')
    if not secret_key:
        return None
    req = urllib.request.Request(
        f'{_BACKEND_API_BASE}{path}',
        headers={'Authorization': f'Bearer {secret_key}'})
    try:
        with urllib.request.urlopen(req, timeout=_BACKEND_API_TIMEOUT) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, ValueError, OSError):
        return None


def fetch_user(user_id: str):
    """The Clerk Backend API's user object for ``user_id``, or None."""
    if not user_id:
        return None
    return _backend_get(f'/users/{user_id}')


def primary_email(clerk_user: dict):
    """The user's primary email address, else their first one, else None."""
    emails = clerk_user.get('email_addresses') or []
    primary_id = clerk_user.get('primary_email_address_id')
    for entry in emails:
        if entry.get('id') == primary_id:
            return entry.get('email_address')
    return emails[0].get('email_address') if emails else None


def display_name(clerk_user: dict):
    """What the UI shows for a Clerk user: username, email, name, id."""
    name = (clerk_user.get('username')
            or ' '.join(p for p in (clerk_user.get('first_name'),
                                    clerk_user.get('last_name')) if p).strip()
            or primary_email(clerk_user)
            or clerk_user.get('id'))
    return name or 'user'


def is_admin(user_id: str, email) -> bool:
    admins = _cfg('CLERK_ADMIN_USERS') or frozenset()
    return (user_id or '').lower() in admins or (email or '').lower() in admins


def _allowed(user_id: str, email) -> bool:
    allowed = _cfg('CLERK_ALLOWED_USERS') or frozenset()
    if not allowed:
        return True
    return (user_id or '').lower() in allowed or (email or '').lower() in allowed


def session_user(token: str):
    """
    Exchange a Clerk session token for a Buzzdrop profile:

        {'username': <clerk user id>, 'email': ..., 'display_name': ...,
         'is_admin': ...}

    None when the token does not verify, the Backend API has no such
    user, or CLERK_ALLOWED_USERS excludes them.
    """
    claims = verify_session_token(token)
    if not claims:
        return None
    clerk_user = fetch_user(claims['sub'])
    if not clerk_user:
        return None
    user_id = clerk_user['id']
    email = primary_email(clerk_user)
    if not _allowed(user_id, email):
        return None
    return {
        'username': user_id,
        'email': email,
        'display_name': display_name(clerk_user),
        'is_admin': is_admin(user_id, email),
    }


def list_users() -> dict:
    """
    The registry ``get_users()`` returns under this backend, keyed by
    Clerk user id, in the env backend's shape plus ``display_name`` and
    ``email``. Cached for a minute: it feeds the admin's user list and
    per-request existence checks.
    """
    now = time.monotonic()
    cached = _user_list_cache['users']
    if cached is not None and now - _user_list_cache['at'] < _USER_LIST_TTL_SECONDS:
        return cached
    users = {}
    data = _backend_get('/users?limit=100')
    for clerk_user in (data if isinstance(data, list) else []):
        email = primary_email(clerk_user)
        users[clerk_user['id']] = {
            'is_admin': is_admin(clerk_user['id'], email),
            'email': email,
            'display_name': display_name(clerk_user),
        }
    _user_list_cache['at'] = now
    _user_list_cache['users'] = users
    return users


def clear_users_cache():
    _user_list_cache['at'] = 0.0
    _user_list_cache['users'] = None


class ClerkBackend(AuthBackend):
    name = 'clerk'
    supports_exchange = True

    def list_users(self) -> dict:
        return list_users()

    def login(self, request):
        # The page mounts clerk.js's SignIn and POSTs the resulting
        # session token to /auth/session. clerk.js and its calls need
        # CSP room beyond the same-origin baseline — granted only on
        # this response via g.csp_extra.
        fapi = frontend_api()
        g.csp_extra = {
            'script-src': [fapi],
            'connect-src': [fapi, 'https://clerk-telemetry.com'],
            'img-src': [fapi, 'https://img.clerk.com'],
            'frame-src': [fapi, 'https://challenges.cloudflare.com'],
            'worker-src': ['blob:'],
        }
        return render_template(
            'login.html',
            auth_backend=self.name,
            clerk_publishable_key=_cfg('CLERK_PUBLISHABLE_KEY'),
            clerk_frontend_api=fapi,
            clerk_js_version=_cfg('CLERK_JS_VERSION', '5'),
            signed_out=request.args.get('signed_out') == '1',
        )

    def exchange(self, request):
        token = (request.get_json(silent=True) or {}).get('token')
        return session_user(token) if token else None

    def session_user(self, username: str, snapshot: dict):
        # The snapshot taken at session bridge — the Flask session is
        # the credential either way. is_admin is re-read from
        # CLERK_ADMIN_USERS, not stored, so a deploy can grant or revoke
        # the flag without waiting out sessions.
        if not snapshot:
            return None
        email = snapshot.get('email')
        return {
            'is_admin': is_admin(username, email),
            'email': email,
            'display_name': snapshot.get('display_name'),
        }

    def after_logout(self) -> dict:
        # A Clerk session lives in clerk.js, not our cookie: the login
        # page signs it out when it sees ?signed_out=1.
        return {'signed_out': '1'}

    def clear_caches(self):
        clear_users_cache()
