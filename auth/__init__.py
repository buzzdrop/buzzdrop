"""
Authentication for Buzzdrop: a swappable-backend package selected by
``AUTH_BACKEND`` (``env`` | ``clerk``), like ``db/`` is selected by
``DATABASE_URL``.

Public surface (unchanged for callers of the old ``auth.py``): the
decorators, the session helpers and ``get_users()``. The backend
interface is ``auth.base.AuthBackend``; ``docs/howto-new-auth-backend.md``
walks through adding one.
"""
from auth.base import AuthBackend
from auth.decorators import (
    admin_required, api_auth_required, bearer_token, login_required,
)
from auth.env_backend import hash_password, is_admin, verify_password
from auth.session import (
    active_session_user, backend_name, get_current_user, get_users,
    logout_user, start_session,
)

__all__ = [
    'AuthBackend',
    'active_session_user', 'admin_required', 'api_auth_required',
    'backend_name', 'bearer_token', 'create_backend', 'get_auth_backend',
    'get_current_user', 'get_users', 'hash_password', 'is_admin',
    'login_required', 'logout_user', 'start_session', 'verify_password',
]

_BACKENDS = {
    'env': ('auth.env_backend', 'EnvBackend'),
    'clerk': ('auth.clerk_backend', 'ClerkBackend'),
}

_instances = {}


def create_backend(name: str) -> AuthBackend:
    """
    Instantiate the backend registered for ``name``.

    Raises:
        ValueError: for a name no backend registers.
    """
    try:
        module_name, class_name = _BACKENDS[name]
    except KeyError:
        raise ValueError(
            f'Unknown AUTH_BACKEND {name!r}; registered: '
            + ', '.join(sorted(_BACKENDS)))
    import importlib
    module = importlib.import_module(module_name)
    return getattr(module, class_name)()


def get_auth_backend() -> AuthBackend:
    """The configured backend, one instance per name."""
    name = backend_name()
    if name not in _instances:
        _instances[name] = create_backend(name)
    return _instances[name]
