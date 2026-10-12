"""
Which language a page is served in (#263, #284): a valid ``lang`` cookie,
then Accept-Language, then DEFAULT_LANGUAGE; the headers and metadata
that say so; POST /language, the only thing that sets the cookie; and
the pages translated so far, in Polish.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from flask import url_for
from werkzeug.exceptions import InternalServerError

from app import handle_server_error
from conftest import CSRF_TOKEN

ROOT = Path(__file__).resolve().parents[2]
NBSP = ' '
ENGLISH_LOGIN = 'Enter the hive'
POLISH_LOGIN = 'Wejdź do ula'


def _login_page(client, **headers):
    return client.get(url_for('login'), headers=headers)


def _language_of(response):
    return response.headers['Content-Language']


def _choose(client, lang='pl', next_path='/login', **extra):
    data = {'lang': lang, 'next': next_path, 'csrf_token': CSRF_TOKEN, **extra}
    return client.post(url_for('set_language'), data=data)


# --- Resolution -----------------------------------------------------------

def test_without_a_preference_the_default_language_is_served(client):
    response = _login_page(client)

    assert _language_of(response) == 'en'
    assert ENGLISH_LOGIN in response.get_data(as_text=True)


def test_accept_language_picks_polish(client):
    response = _login_page(client, **{'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'})

    assert _language_of(response) == 'pl'
    assert POLISH_LOGIN in response.get_data(as_text=True)


def test_an_unsupported_language_falls_through_to_the_next_preference(client):
    response = _login_page(client, **{'Accept-Language': 'de-DE,fr;q=0.9,pl;q=0.5'})

    assert _language_of(response) == 'pl'


def test_no_supported_language_gets_the_default(client):
    assert _language_of(_login_page(client, **{'Accept-Language': 'de, fr'})) == 'en'


def test_the_cookie_overrides_accept_language(client):
    client.set_cookie('lang', 'en')

    response = _login_page(client, **{'Accept-Language': 'pl'})

    assert _language_of(response) == 'en'
    assert ENGLISH_LOGIN in response.get_data(as_text=True)


@pytest.mark.parametrize('value', ['de', 'xx', 'PL', '', 'pl;', '../pl'])
def test_an_invalid_cookie_is_ignored(client, value):
    client.set_cookie('lang', value)

    assert _language_of(_login_page(client, **{'Accept-Language': 'pl'})) == 'pl'
    assert _language_of(_login_page(client)) == 'en'


def test_the_default_language_comes_from_config(app, client):
    app.config['DEFAULT_LANGUAGE'] = 'pl'
    try:
        assert _language_of(_login_page(client)) == 'pl'
    finally:
        app.config['DEFAULT_LANGUAGE'] = 'en'


def test_a_language_left_out_of_languages_is_not_served(app, client):
    app.config['LANGUAGES'] = ['en']
    try:
        client.set_cookie('lang', 'pl')
        assert _language_of(_login_page(client, **{'Accept-Language': 'pl'})) == 'en'
    finally:
        app.config['LANGUAGES'] = ['en', 'pl']


# --- Headers and metadata -------------------------------------------------

def test_a_rendered_page_says_it_varies_by_language(client):
    response = _login_page(client, **{'Accept-Language': 'pl'})

    assert {'Accept-Language', 'Cookie'} <= set(response.vary)
    assert _language_of(response) == 'pl'


@pytest.mark.parametrize('language, og_locale', [('en', 'en_US'), ('pl', 'pl_PL')])
def test_html_lang_and_og_locale_follow_the_language(client, language, og_locale):
    html = _login_page(client, **{'Accept-Language': language}).get_data(as_text=True)

    assert f'<html lang="{language}"' in html
    assert f'<meta property="og:locale" content="{og_locale}">' in html
    assert 'hreflang' not in html


def test_responses_not_rendered_from_a_template_do_not_vary_by_language(client):
    response = client.get('/static/css/app.css', headers={'Accept-Language': 'pl'})

    assert 'Content-Language' not in response.headers
    assert 'Accept-Language' not in response.vary


def test_json_responses_stay_english(client):
    response = client.get('/api/does-not-exist', headers={'Accept-Language': 'pl'})

    assert response.get_json() == {'error': 'Not found'}
    assert 'Content-Language' not in response.headers


# --- POST /language -------------------------------------------------------

def test_choosing_a_language_sets_the_cookie_and_goes_back(client):
    response = _choose(client, 'pl', '/how-it-works?sender=cli')

    assert response.status_code == 303
    assert response.headers['Location'] == '/how-it-works?sender=cli'
    assert client.get_cookie('lang').value == 'pl'
    assert _language_of(_login_page(client, **{'Accept-Language': 'en'})) == 'pl'


def test_the_language_cookie_flags(client):
    response = _choose(client, 'pl')

    cookie = response.headers['Set-Cookie']
    assert cookie.startswith('lang=pl;')
    assert 'Max-Age=31536000' in cookie
    assert 'SameSite=Lax' in cookie
    assert 'HttpOnly' in cookie
    assert 'Path=/' in cookie
    assert 'Secure' not in cookie  # SESSION_COOKIE_SECURE is off under test


def test_the_language_cookie_is_secure_when_session_cookies_are(app, client):
    app.config['SESSION_COOKIE_SECURE'] = True
    try:
        response = _choose(client, 'pl')
    finally:
        app.config['SESSION_COOKIE_SECURE'] = False

    assert 'Secure' in [part.strip() for part in response.headers['Set-Cookie'].split(';')]


@pytest.mark.parametrize('form', [
    {'csrf_token': 'wrong'},
    {'csrf_token': ''},
])
def test_choosing_a_language_requires_the_csrf_token(client, form):
    response = _choose(client, 'pl', **form)

    assert response.status_code == 303
    assert client.get_cookie('lang') is None


def test_choosing_a_language_without_a_session_token_is_refused(client):
    with client.session_transaction() as session:
        session.pop('csrf_token')

    response = _choose(client, 'pl')

    assert response.status_code == 303
    assert client.get_cookie('lang') is None


def test_an_authorization_header_does_not_exempt_the_language_form(client):
    response = client.post(url_for('set_language'), data={'lang': 'pl', 'next': '/'},
                           headers={'Authorization': 'Bearer anything'})

    assert response.status_code == 303
    assert client.get_cookie('lang') is None


@pytest.mark.parametrize('lang', ['de', 'xx', '', 'pl\r\nSet-Cookie: x=1'])
def test_an_unknown_language_sets_no_cookie(client, lang):
    response = _choose(client, lang)

    assert response.status_code == 303
    assert client.get_cookie('lang') is None


@pytest.mark.parametrize('next_path', [
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    '\\\\evil.example',
    'javascript:alert(1)',
    'evil.example',
    '/\t/evil.example',
    '/x\r\nLocation: https://evil.example',
    '',
])
def test_next_must_be_a_local_path(client, next_path):
    response = _choose(client, 'pl', next_path)

    assert response.status_code == 303
    assert response.headers['Location'] == '/'


def test_missing_next_goes_home(client):
    response = client.post(url_for('set_language'),
                           data={'lang': 'pl', 'csrf_token': CSRF_TOKEN})

    assert response.headers['Location'] == '/'
    assert client.get_cookie('lang').value == 'pl'


def test_only_the_language_form_sets_the_cookie(client):
    for response in (
        _login_page(client, **{'Accept-Language': 'pl'}),
        client.get('/', headers={'Accept-Language': 'pl'}),
        client.get('/view/never-existed', headers={'Accept-Language': 'pl'}),
    ):
        assert 'lang=' not in ' '.join(response.headers.getlist('Set-Cookie'))


# --- Startup validation ---------------------------------------------------

@pytest.mark.parametrize('env, message', [
    ({'LANGUAGES': 'en', 'DEFAULT_LANGUAGE': 'pl'}, 'DEFAULT_LANGUAGE'),
    ({'LANGUAGES': 'en,de'}, "'de', but it has no compiled catalog"),
    ({'LANGUAGES': 'en,xx'}, 'pseudo-locale'),
    ({'LANGUAGES': ' , '}, 'at least one language'),
])
def test_startup_fails_on_a_bad_language_setup(tmp_path, env, message):
    environment = {
        **os.environ,
        'FLASK_ENV': 'testing',
        'DATABASE_URL': f'sqlite:///{tmp_path}/startup.db',
        'UPLOAD_FOLDER': str(tmp_path / 'uploads'),
        'EXPIRY_SWEEP_INTERVAL_SECONDS': '0',
        **env,
    }
    result = subprocess.run([sys.executable, '-c', 'import app'], cwd=ROOT,
                            env=environment, capture_output=True, text=True)

    assert result.returncode != 0
    assert message in result.stderr


# --- The pages translated so far ------------------------------------------

def _polish(client, method, path, **kwargs):
    return client.open(path, method=method, headers={'Accept-Language': 'pl'}, **kwargs)


def test_the_login_page_in_polish(client):
    html = _polish(client, 'GET', url_for('login')).get_data(as_text=True)

    assert '<title>Buzzdrop: bezpieczne, jednorazowe przesyłanie plików</title>' in html
    assert 'Nazwa użytkownika' in html
    assert 'Kod źródłowy' in html
    # A one-letter word keeps to the next one.
    assert f'w{NBSP}zmiennych środowiskowych' in html


def test_the_gone_page_in_polish(client):
    response = _polish(client, 'GET', url_for('view_file', file_id='never-existed'))

    assert response.status_code == 404
    html = response.get_data(as_text=True)
    assert 'Tej przesyłki już nie ma' in html
    assert 'Przejdź do Buzzdropa' in html
    assert _language_of(response) == 'pl'


def test_an_unknown_url_in_polish(client):
    response = _polish(client, 'GET', '/does-not-exist')

    assert response.status_code == 404
    assert 'Nie znaleziono strony' in response.get_data(as_text=True)


def test_a_server_error_page_in_polish(app):
    with app.test_request_context('/', headers={'Accept-Language': 'pl'}):
        body, status = handle_server_error(InternalServerError())

    assert status == 500
    assert 'Coś poszło nie tak' in body


def test_login_and_logout_flashes_in_polish(client, csrf_form_data):
    client.set_cookie('lang', 'pl')

    response = client.post(url_for('login'), data={'username': 'testuser', 'password': 'nope'})
    assert 'Nieprawidłowa nazwa użytkownika lub hasło' in response.get_data(as_text=True)

    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
    assert 'Zalogowano' in client.get('/').get_data(as_text=True)

    client.post(url_for('logout'), data=csrf_form_data())
    assert 'Wylogowano' in client.get('/').get_data(as_text=True)


def test_the_header_in_polish_when_logged_in_as_admin(client):
    client.post(url_for('login'), data={'username': 'adminuser', 'password': 'adminpass'})

    html = _polish(client, 'GET', url_for('view_file', file_id='never-existed')).get_data(as_text=True)

    assert '>Użytkownicy</a>' in html
    assert '>Wyloguj</button>' in html
