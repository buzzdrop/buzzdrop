"""
The explainer lives on the Website, so every "How it works" link reads
EXPLAINER_URL (#360): the default, a custom value, and none at all when the
setting is empty. The App serves no /how-it-works of its own.
"""
import pytest
from flask import url_for

from conftest import CSRF_TOKEN

DEFAULT = 'https://buzzdrop.io/how-it-works'
CUSTOM = 'https://example.com/explainer'


def _login(client):
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})


def _pages(client, bound_share, file_record):
    """Each page that links to the explainer, by name, as HTML."""
    file_id = file_record()
    bound_share(file_id)
    return {
        'login': client.get(url_for('login')),
        'view': client.get(url_for('view_file', file_id=file_id)),
        'confirm': client.post(url_for('confirm_view_file', file_id=file_id),
                               data={'csrf_token': CSRF_TOKEN}),
    }


@pytest.mark.parametrize('value, expected', [(None, DEFAULT), (CUSTOM, CUSTOM)])
def test_every_explainer_link_follows_the_setting(app, client, bound_share, file_record, monkeypatch, value, expected):
    if value:
        monkeypatch.setitem(app.config, 'EXPLAINER_URL', value)

    for name, response in _pages(client, bound_share, file_record).items():
        assert response.status_code == 200, name
        assert f'href="{expected}"' in response.get_data(as_text=True), name


def test_no_explainer_link_when_the_setting_is_empty(app, client, bound_share, file_record, monkeypatch):
    monkeypatch.setitem(app.config, 'EXPLAINER_URL', '')

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


def test_dead_link_follows_a_custom_explainer(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'EXPLAINER_URL', CUSTOM)

    assert f'href="{CUSTOM}" class="btn-primary' in _dead_link(client)


def test_dead_link_has_no_button_for_an_anonymous_visitor_without_an_explainer(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'EXPLAINER_URL', '')
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
    assert 'Przejdź do Buzzdropa' in logged_in
