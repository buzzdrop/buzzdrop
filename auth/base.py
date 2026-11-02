"""
The auth backend interface (auth/CLAUDE.md).

A backend owns who the users are and how they sign in. The rest of the
app sees an ordinary Flask session and these primitives; the decorators
(``login_required``, ``admin_required``, ``api_auth_required``), the
session CSRF token and ``g.username`` are backend-agnostic.

A *profile* is the dict a backend returns to start a session::

    {'username': str,            # the stable id stored against drops,
                                 # dropzones and API tokens
     'display_name': str|None,   # what the UI shows (defaults to username)
     'email': str|None,
     'is_admin': bool}
"""
from abc import ABC, abstractmethod


class AuthBackend(ABC):
    """
    Contract for a sign-in backend, selected by ``AUTH_BACKEND``
    (config.py). ``get_auth_backend()`` instantiates one per name.

    To add one (``docs/howto-new-auth-backend.md``): implement the four
    abstract members, register the name in ``auth.create_backend`` and
    pass ``tests/contract/test_auth_backend_contract.py``.
    """

    name = 'abstract'
    #: whether POST /auth/session delegates to exchange()
    supports_exchange = False

    @abstractmethod
    def list_users(self) -> dict:
        """
        The user registry, in the shape ``{'username': {...}}`` — it
        feeds the admin's user list and the API-token existence checks.
        Values must carry ``is_admin`` and may carry ``email`` and
        ``display_name``.
        """

    @abstractmethod
    def login(self, request):
        """
        Own /login entirely — GET and POST. Render the page
        (login.html reads ``auth_backend`` and the backend's context
        keys), redirect elsewhere (an OIDC authorize URL), or start a
        session with ``auth.session.start_session`` and redirect.
        """

    def exchange(self, request):
        """
        A credential → profile exchange reached by POST /auth/session
        (e.g. the Clerk session-JWT bridge). The route has already
        required the ``X-Requested-With`` header. Return the profile to
        start a session for, or None to refuse (the route answers 401).
        Only called when ``supports_exchange`` is True.
        """
        return None

    @abstractmethod
    def session_user(self, username: str, snapshot: dict):
        """
        Resolve the session's user each request: ``username`` is
        ``session['username']`` and ``snapshot`` the dict stored at
        sign-in. Return the user dict (``is_admin`` read live where
        possible), or None to drop the session.
        """

    def after_logout(self) -> dict:
        """Extra ``/login`` query args the /logout redirect carries
        (the clerk backend's ``signed_out``)."""
        return {}

    def clear_caches(self):
        """Drop any cached user data (conftest clears between tests)."""
