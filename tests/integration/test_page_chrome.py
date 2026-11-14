"""
The shared page chrome from templates/base.html: the header's links and
buttons and the footer note, as the server renders them per page (#232).
How the header lays out at narrow widths is a visual property; the E2E
spec tests/e2e/header.spec.js covers it.
"""
import io
import re
from html import unescape

import pytest
from flask import url_for
from werkzeug.exceptions import BadRequest, ImATeapot

from app import handle_http_error


def _login(client, username='testuser', password='password'):
    response = client.post(url_for('login'), data={'csrf_token': 'test-csrf-token', 'username': username, 'password': password})
    assert response.status_code == 302


@pytest.fixture
def as_admin(client):
    _login(client, 'adminuser', 'adminpass')


def _region(client, endpoint, tag, **values):
    response = client.get(url_for(endpoint, **values))
    match = re.search(rf'<{tag}\b.*?</{tag}>', response.get_data(as_text=True), re.S)
    assert match, f'no <{tag}> on {endpoint}'
    return match.group(0)


def _header(client, endpoint, **values):
    return _region(client, endpoint, 'nav', **values)


def _footer(client, endpoint, **values):
    return _region(client, endpoint, 'footer', **values)


# An icon assistive tech skips, in front of a control's text.
_HIDDEN_ICON = r'(?:<svg\b[^>]*aria-hidden="true".*?</svg>\s*)?'


def _tag_with_text(html, text):
    """The opening tag of the element whose own text is ``text``."""
    match = re.search(rf'(<(a|button)\b[^>]*>)\s*{_HIDDEN_ICON}{re.escape(text)}\s*</\2>', html, re.S)
    assert match, f'no <a>/<button> labelled {text!r}'
    return match.group(1)


def test_header_does_not_offer_login_on_the_login_page(client):
    assert f'href="{url_for("login")}"' not in _header(client, 'login')


def test_logout_is_not_styled_as_destructive(client):
    _login(client)
    logout = _tag_with_text(_header(client, 'index'), 'Logout')
    assert 'btn-danger' not in logout
    assert 'btn-secondary' in logout


def test_manage_users_is_marked_current_on_the_users_page(client, as_admin):
    assert 'aria-current="page"' in _tag_with_text(_header(client, 'manage_users'), 'Manage Users')


def test_manage_users_is_not_marked_current_elsewhere(client, as_admin):
    assert 'aria-current' not in _tag_with_text(_header(client, 'index'), 'Manage Users')


def test_users_page_has_no_back_to_home_link(client, as_admin):
    assert 'Back to home' not in client.get(url_for('manage_users')).get_data(as_text=True)


@pytest.mark.parametrize('endpoint, values', [
    ('manage_users', {}),
    ('view_file', {'file_id': 'missing'}),
])
def test_footer_note_is_neutral_by_default(client, as_admin, endpoint, values):
    footer = _footer(client, endpoint, **values)
    assert 'Each drop opens once' in footer
    assert 'key' not in footer.lower()
    assert 'password' not in footer.lower()


def test_footer_tells_the_uploader_to_split_link_and_password(client):
    _login(client)
    assert 'Send the link and the password through different channels' in _footer(client, 'index')


def test_success_page_footer_tells_the_uploader_to_split_link_and_password(client, file_record):
    _login(client)
    footer = _footer(client, 'upload_success', file_id=file_record())
    assert 'Send the link and the password through different channels' in footer


def test_other_pages_keep_the_footer_note(client):
    # /login only renders for anonymous visitors (#404), so its neutral
    # footer is checked here rather than under as_admin.
    footer = _footer(client, 'login')
    assert 'Each drop opens once' in footer
    assert 'key' not in footer.lower()
    assert 'password' not in footer.lower()


@pytest.mark.parametrize('endpoint, values', [
    ('login', {}),
])
def test_footer_says_how_it_is_built(client, endpoint, values):
    footer = _footer(client, endpoint, **values)
    assert 'Built in the open.' in footer
    assert 'vibe coding' not in footer


@pytest.mark.parametrize('endpoint, values', [
    ('login', {}),
    ('view_file', {'file_id': 'missing'}),
])
def test_footer_links_to_the_source_code(client, endpoint, values):
    footer = _footer(client, endpoint, **values)
    assert 'href="https://github.com/buzzdrop/buzzdrop"' in _tag_with_text(footer, 'Source code')
    assert 'href="https://www.gnu.org/licenses/agpl-3.0.html"' in _tag_with_text(footer, 'AGPL-3.0')


def _assert_links_to_source_and_licence(html):
    footer = re.search(r'<footer\b.*?</footer>', html, re.S)
    assert footer, 'no <footer>'
    assert 'href="https://github.com/buzzdrop/buzzdrop"' in _tag_with_text(footer.group(0), 'Source code')
    assert 'href="https://www.gnu.org/licenses/agpl-3.0.html"' in _tag_with_text(footer.group(0), 'AGPL-3.0')


@pytest.fixture
def rate_limited(app, monkeypatch):
    """The second of two requests a minute is a 429."""
    monkeypatch.setitem(app.config, 'PUBLIC_FILE_RATE_LIMIT', '1 per minute')
    monkeypatch.setitem(app.config, 'REPORT_DECRYPTION_RATE_LIMIT', '1 per minute')

    def second(send):
        send()
        return send()
    return second


def test_rate_limit_page_links_to_the_source_code(client, rate_limited):
    response = rate_limited(lambda: client.get(url_for('view_file', file_id='missing')))

    assert response.status_code == 429
    html = response.get_data(as_text=True)
    assert 'Slow down' in html
    assert 'Too many requests. Please try again later.' in html
    _assert_links_to_source_and_licence(html)


def test_rate_limit_answers_xhr_clients_with_json(client, rate_limited):
    response = rate_limited(lambda: client.get(url_for('view_file', file_id='missing'),
                                               headers={'X-Requested-With': 'XMLHttpRequest'}))

    assert response.status_code == 429
    assert response.get_json() == {'error': 'Too many requests. Please try again later.', 'code': 'rate_limited'}


def test_rate_limit_answers_a_json_body_with_json(client, rate_limited):
    # The browser's receipt report is a plain fetch with a JSON body and no
    # X-Requested-With; no page navigation sends JSON.
    response = rate_limited(lambda: client.post(url_for('report_decryption', file_id='missing-id'),
                                                json={'success': False}))

    assert response.status_code == 429
    assert response.get_json() == {'error': 'Too many requests. Please try again later.', 'code': 'rate_limited'}


def _allowed(response):
    return {method.strip() for method in response.headers['Allow'].split(',')}


def test_method_not_allowed_page_links_to_the_source_code(client):
    response = client.get(url_for('set_language'))

    assert response.status_code == 405
    assert _allowed(response) == {'OPTIONS', 'POST'}
    html = response.get_data(as_text=True)
    assert "This request didn't go through" in unescape(html)
    _assert_links_to_source_and_licence(html)


def test_method_not_allowed_answers_api_clients_with_json(client):
    response = client.get(url_for('create_api_token'))

    assert response.status_code == 405
    assert _allowed(response) == {'OPTIONS', 'POST'}
    assert response.get_json() == {'error': 'Method Not Allowed', 'code': 'method_not_allowed'}


def test_bad_request_page_links_to_the_source_code(app):
    # No route raises a bare 400 today, so the handler is called directly.
    with app.test_request_context('/'):
        response = app.make_response(handle_http_error(BadRequest()))

    assert response.status_code == 400
    _assert_links_to_source_and_licence(response.get_data(as_text=True))


def test_bad_request_answers_api_clients_with_json(app):
    with app.test_request_context('/api/token'):
        response = app.make_response(handle_http_error(BadRequest()))

    assert response.status_code == 400
    assert response.get_json() == {'error': 'Bad Request', 'code': 'bad_request'}


def test_an_unlisted_status_answers_api_clients_with_the_generic_code(app):
    with app.test_request_context('/api/token'):
        response = app.make_response(handle_http_error(ImATeapot()))

    assert response.status_code == 418
    assert response.get_json() == {'error': "I'm a teapot", 'code': 'http_error'}


def test_too_large_drop_lands_on_a_page_that_links_to_the_source_code(app, client, monkeypatch):
    _login(client)
    monkeypatch.setitem(app.config, 'MAX_CONTENT_LENGTH', 10)

    response = client.post(url_for('upload_file'), data={'file': (io.BytesIO(b'more than ten bytes'), 'big.txt')},
                           content_type='multipart/form-data', follow_redirects=True)

    html = response.get_data(as_text=True)
    assert 'Drop too large' in html
    _assert_links_to_source_and_licence(html)


def test_footer_source_link_shows_the_github_icon(client):
    # The GitHub mark is hidden from assistive tech: the link's label already
    # says where it goes.
    link = re.search(r'<a\b[^>]*>(?:(?!</a>).)*?Source code\s*</a>', _footer(client, 'login'), re.S).group(0)

    assert re.search(r'<svg\b[^>]*aria-hidden="true"', link)


def test_footer_source_link_follows_the_configured_url(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'SOURCE_CODE_URL', 'https://git.example.org/fork')
    footer = _footer(client, 'login')
    assert 'href="https://git.example.org/fork"' in _tag_with_text(footer, 'Source code')


def test_every_repository_link_follows_the_configured_url(app, client, monkeypatch):
    # A fork that sets SOURCE_CODE_URL must not keep sending its users to
    # the upstream repository from the header or the login page.
    monkeypatch.setitem(app.config, 'SOURCE_CODE_URL', 'https://git.example.org/fork')
    page = client.get(url_for('login')).get_data(as_text=True)
    assert 'github.com/luprzybyl' not in page
    assert 'href="https://git.example.org/fork"' in page


def test_the_header_leaves_the_source_link_to_the_page(client):
    # Every footer already links to the source, so the header doesn't repeat it.
    assert 'Source code' not in _header(client, 'login')
