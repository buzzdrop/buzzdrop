"""
First-run token setup in the CLI, against the real app's answers (#435).

``setup_token`` talks through ``requests``, which the test environment does
not install. ``FlaskRequests`` puts the part of its interface the CLI uses
onto the Flask test client, so each login, redirect, page and token answer
comes from the app itself.
"""
import getpass
import json
import stat
from urllib.parse import urlsplit

import pytest

from conftest import import_buzz

SERVER = 'https://localhost'


buzz = import_buzz()


class _Response:
    """The part of ``requests.Response`` the CLI reads."""

    def __init__(self, flask_response):
        self.status_code = flask_response.status_code
        self.ok = flask_response.status_code < 400
        self.text = flask_response.get_data(as_text=True)
        self.url = f'{SERVER}{flask_response.request.path}'

    def json(self):
        return json.loads(self.text)


class FlaskRequests:
    """Stands in for the ``requests`` module, one test client per Session."""

    class RequestException(Exception):
        pass

    class ConnectionError(RequestException):
        pass

    def __init__(self, app, alter_request=None, alter_response=None):
        self._app = app
        self.alter_request = alter_request
        self.alter_response = alter_response

    def Session(self):
        return _Session(self._app.test_client(), self)


class _Session:
    def __init__(self, client, transport):
        self._client = client
        self._transport = transport

    def get(self, url, headers=None, timeout=None):
        parts = urlsplit(url)
        request = {'headers': dict(headers or {})}
        if self._transport.alter_request:
            self._transport.alter_request(parts.path, request)
        response = _Response(self._client.get(
            parts.path,
            base_url=f'{parts.scheme}://{parts.netloc}',
            **request,
        ))
        if self._transport.alter_response:
            self._transport.alter_response(parts.path, response)
        return response

    def post(self, url, data=None, json=None, headers=None,
             allow_redirects=True, timeout=None):
        parts = urlsplit(url)
        request = {'data': data, 'json': json, 'headers': dict(headers or {})}
        if self._transport.alter_request:
            self._transport.alter_request(parts.path, request)
        response = _Response(self._client.post(
            parts.path,
            base_url=f'{parts.scheme}://{parts.netloc}',
            follow_redirects=allow_redirects,
            **request,
        ))
        if self._transport.alter_response:
            self._transport.alter_response(parts.path, response)
        return response


@pytest.fixture
def run_setup(app, db_instance, monkeypatch, tmp_path):
    """Run setup_token with the prompts answered and the token file in tmp."""
    token_file = tmp_path / '.buzz_token'
    monkeypatch.setattr(buzz, 'TOKEN_FILE', str(token_file))

    def _run(username, password, transport=None, label=''):
        monkeypatch.setattr(
            'builtins.input',
            lambda prompt='': label if prompt.startswith('Token label') else username)
        monkeypatch.setattr(getpass, 'getpass', lambda prompt='': password)
        monkeypatch.setattr(buzz, '_requests', lambda: transport or FlaskRequests(app))
        return buzz.setup_token(server_override=SERVER)

    _run.token_file = token_file
    return _run


def test_first_run_setup_gets_a_token_that_authenticates(app, run_setup):
    token, server = run_setup('testuser', 'password')

    assert server == SERVER
    saved = json.loads(run_setup.token_file.read_text())
    assert saved == {'token': token, 'server': SERVER}
    assert stat.S_IMODE(run_setup.token_file.stat().st_mode) == 0o600

    response = app.test_client().get(
        '/api/dropzones', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200


def _token_labels(app):
    from tokens import list_api_tokens
    with app.app_context():
        return [token['label'] for token in list_api_tokens('testuser')]


def test_first_run_setup_labels_the_token_with_this_machine(
        app, run_setup, monkeypatch):
    monkeypatch.setattr(buzz.socket, 'gethostname', lambda: 'work-laptop')
    run_setup('testuser', 'password')

    assert _token_labels(app) == ['buzz CLI on work-laptop']


def test_a_long_hostname_is_cut_to_the_label_limit(app, run_setup, monkeypatch):
    monkeypatch.setattr(buzz.socket, 'gethostname', lambda: 'h' * 200)
    run_setup('testuser', 'password')

    assert _token_labels(app) == [('buzz CLI on ' + 'h' * 200)[:buzz.TOKEN_LABEL_MAX_LENGTH]]


def test_first_run_setup_takes_the_label_typed_at_its_prompt(app, run_setup):
    run_setup('testuser', 'password', label='  backup job  ')

    assert _token_labels(app) == ['backup job']


def test_a_label_over_the_limit_stops_setup_before_logging_in(
        app, run_setup, capsys):
    class Offline(FlaskRequests):
        def Session(self):
            raise AssertionError('setup reached the server')

    too_long = 'x' * (buzz.TOKEN_LABEL_MAX_LENGTH + 1)
    with pytest.raises(SystemExit):
        run_setup('testuser', 'password', transport=Offline(app), label=too_long)

    assert 'at most 64 characters' in capsys.readouterr().err
    assert not run_setup.token_file.exists()
    assert _token_labels(app) == []


def test_the_cli_label_limit_matches_the_server(app):
    from tokens import TOKEN_LABEL_MAX_LENGTH

    assert buzz.TOKEN_LABEL_MAX_LENGTH == TOKEN_LABEL_MAX_LENGTH


PERMISSION_MESSAGE = 'does not have permission'


def test_a_csrf_refusal_is_not_reported_as_a_permission_problem(
        app, run_setup, capsys):
    def drop_csrf_token(path, request):
        if path == '/api/token':
            request['headers'].pop('X-CSRF-Token')

    with pytest.raises(SystemExit) as exit_info:
        run_setup('testuser', 'password',
                  transport=FlaskRequests(app, drop_csrf_token))

    assert exit_info.value.code == 1
    error = capsys.readouterr().err
    assert PERMISSION_MESSAGE not in error
    assert 'CSRF' in error
    assert not run_setup.token_file.exists()


def test_an_admin_refusal_is_reported_as_a_permission_problem(
        app, run_setup, capsys):
    def ask_for_another_user(path, request):
        if path == '/api/token':
            request['json'] = {'username': 'adminuser'}

    with pytest.raises(SystemExit) as exit_info:
        run_setup('testuser', 'password',
                  transport=FlaskRequests(app, ask_for_another_user))

    assert exit_info.value.code == 1
    assert PERMISSION_MESSAGE in capsys.readouterr().err
    assert not run_setup.token_file.exists()


def test_a_wrong_password_is_reported_as_a_failed_login(run_setup, capsys):
    with pytest.raises(SystemExit) as exit_info:
        run_setup('testuser', 'not-the-password')

    assert exit_info.value.code == 1
    assert 'login failed' in capsys.readouterr().err
    assert not run_setup.token_file.exists()


def test_a_page_without_a_csrf_token_stops_setup_with_a_clear_error(
        app, run_setup, capsys):
    posted = []

    def record_path(path, request):
        posted.append(path)

    def strip_csrf_meta(path, response):
        if path == '/login':
            assert 'name="csrf-token"' in response.text
            response.text = response.text.replace(
                'name="csrf-token"', 'name="not-it"')

    with pytest.raises(SystemExit) as exit_info:
        run_setup('testuser', 'password',
                  transport=FlaskRequests(app, record_path, strip_csrf_meta))

    assert exit_info.value.code == 1
    assert 'found no CSRF token' in capsys.readouterr().err
    assert posted == ['/login']
    assert not run_setup.token_file.exists()
