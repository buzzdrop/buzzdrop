"""
The explainer lives on the Website, so every "How it works" link is built
from WEBSITE_URL (#360) in the page's language (#371): the default, a custom
value, and none at all when the setting is empty. The App serves no
/how-it-works of its own.
"""
import pytest
from flask import url_for

from conftest import CSRF_TOKEN

DEFAULT = 'https://buzzdrop.io/en/how-it-works/'
DEFAULT_PL = 'https://buzzdrop.io/pl/jak-to-dziala/'
CUSTOM = 'https://example.com/en/how-it-works/'


def _login(client):
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})


def _pages(client, bound_share, file_record, **headers):
    """Each page that links to the explainer, by name, as HTML."""
    file_id = file_record()
    bound_share(file_id)
    return {
        'login': client.get(url_for('login'), headers=headers),
        'view': client.get(url_for('view_file', file_id=file_id), headers=headers),
        'confirm': client.post(url_for('confirm_view_file', file_id=file_id),
                               data={'csrf_token': CSRF_TOKEN}, headers=headers),
    }


@pytest.mark.parametrize('value, expected', [
    (None, DEFAULT), ('https://example.com', CUSTOM), ('https://example.com/', CUSTOM)])
def test_every_explainer_link_follows_the_setting(app, client, bound_share, file_record, monkeypatch, value, expected):
    if value:
        monkeypatch.setitem(app.config, 'WEBSITE_URL', value)

    for name, response in _pages(client, bound_share, file_record).items():
        assert response.status_code == 200, name
        assert f'href="{expected}"' in response.get_data(as_text=True), name


def test_every_explainer_link_follows_the_page_language(client, bound_share, file_record):
    for name, response in _pages(client, bound_share, file_record, **{'Accept-Language': 'pl'}).items():
        html = response.get_data(as_text=True)
        assert f'href="{DEFAULT_PL}"' in html, name
        assert DEFAULT not in html, name


def test_the_language_menu_choice_beats_the_browser_language(client, bound_share, file_record):
    client.set_cookie('lang', 'pl')

    for name, response in _pages(client, bound_share, file_record, **{'Accept-Language': 'en'}).items():
        html = response.get_data(as_text=True)
        assert f'href="{DEFAULT_PL}"' in html, name
        assert DEFAULT not in html, name


def test_no_explainer_link_when_the_setting_is_empty(app, client, bound_share, file_record, monkeypatch):
    monkeypatch.setitem(app.config, 'WEBSITE_URL', '')

    for name, response in _pages(client, bound_share, file_record).items():
        html = response.get_data(as_text=True)
        assert 'How it works' not in html, name
        assert 'See how Buzzdrop works' not in html, name
        assert 'how-it-works' not in html, name


def test_the_app_serves_no_explainer(client):
    assert client.get('/how-it-works').status_code == 404


def _dead_link(client, **headers):
    return client.get(url_for('view_file', file_id='nonexistentid'), headers=headers).get_data(as_text=True)


def test_dead_link_offers_the_explainer_to_an_anonymous_visitor(client):
    html = _dead_link(client)

    assert f'href="{DEFAULT}"' in html
    assert 'How Buzzdrop works' in html
    assert 'Go to Buzzdrop' not in html


def test_dead_link_follows_a_custom_website(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'WEBSITE_URL', 'https://example.com')

    assert f'href="{CUSTOM}" class="btn-primary' in _dead_link(client)


def test_dead_link_has_no_button_for_an_anonymous_visitor_without_an_explainer(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'WEBSITE_URL', '')
    html = _dead_link(client)

    assert 'btn-primary' not in html
    assert 'How Buzzdrop works' not in html


def test_dead_link_sends_a_logged_in_user_home(client):
    _login(client)
    html = _dead_link(client)

    assert 'Go to Buzzdrop' in html
    assert 'How Buzzdrop works' not in html
    assert f'href="{url_for("index")}" class="btn-primary' in html


def test_dead_link_buttons_are_translated(client):
    anonymous = _dead_link(client, **{'Accept-Language': 'pl'})
    _login(client)
    logged_in = _dead_link(client, **{'Accept-Language': 'pl'})

    assert 'Jak działa Buzzdrop' in anonymous
    assert f'href="{DEFAULT_PL}" class="btn-primary' in anonymous
    assert 'Przejdź do Buzzdropa' in logged_in
