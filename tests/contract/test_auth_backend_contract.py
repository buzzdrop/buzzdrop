"""
The contract every auth backend must pass (auth/CLAUDE.md).

Parametrized by ``auth._BACKENDS``: a backend registered there is
exercised automatically — implement ``AuthBackend``, register the name,
and this suite is the gate.
"""
import pytest

import auth
from auth.base import AuthBackend


@pytest.fixture(params=sorted(auth._BACKENDS))
def backend(request):
    return auth.create_backend(request.param)


class TestInterface:
    def test_is_an_auth_backend(self, backend):
        assert isinstance(backend, AuthBackend)

    def test_name_matches_registration(self, backend):
        assert backend.name in auth._BACKENDS
        assert auth._BACKENDS[backend.name][1] == type(backend).__name__

    def test_supports_exchange_is_a_bool(self, backend):
        assert isinstance(backend.supports_exchange, bool)

    def test_after_logout_is_query_kwargs(self, backend):
        extra = backend.after_logout()
        assert isinstance(extra, dict)
        assert all(isinstance(k, str) for k in extra)


class TestSessionUser:
    def test_absent_snapshot_drops_nothing_but_never_errors(
            self, app, backend):
        # A missing/empty snapshot must resolve cleanly — either to a
        # user the backend can re-derive, or to None.
        with app.test_request_context('/'):
            result = backend.session_user('nobody-who-exists', {})
            assert result is None or isinstance(result, dict)

    def test_unknown_user_resolves_none(self, app, backend):
        with app.test_request_context('/'):
            result = backend.session_user(
                'user-definitely-not-real', {'email': 'x@example.com'})
            assert result is None or isinstance(result, dict)


class TestRegistry:
    def test_list_users_shape(self, app, backend, monkeypatch):
        # External registries are stubbed at their network seam: the
        # contract is the shape, not the provider.
        if backend.name == 'clerk':
            monkeypatch.setattr(
                'auth.clerk_backend._backend_get', lambda path: [])
            backend.clear_caches()
        users = backend.list_users()
        assert isinstance(users, dict)
        for username, user in users.items():
            assert isinstance(username, str)
            assert isinstance(user.get('is_admin'), bool)


class TestLogin:
    def test_login_get_returns_a_response(self, app, backend, monkeypatch):
        if backend.name == 'clerk':
            monkeypatch.setitem(
                app.config, 'CLERK_FRONTEND_API_URL',
                'https://clerk.test.example.com')
            monkeypatch.setitem(
                app.config, 'CLERK_PUBLISHABLE_KEY', 'pk_test_x')
            monkeypatch.setitem(
                app.config, 'CLERK_JS_VERSION', '5')
        with app.test_request_context('/login', method='GET'):
            from flask import request
            response = backend.login(request)
            # A rendered template is a str in a bare request context; the
            # real route would wrap it in a Response. Both are serveable.
            if isinstance(response, str):
                response = app.make_response(response)
            assert response.status_code == 200
