"""
The notice on an ephemeral instance (#398): EPHEMERAL_INSTANCE, set only by
the Try it button configs, tells every visitor that the instance keeps no
data across restarts. Text only: nothing else changes.
"""
import pytest
from flask import url_for

STRIP = 'This instance keeps no data across restarts.'
GONE_LINE = 'The drop may have been lost when this instance restarted.'


def _pages(client):
    return {
        'login': client.get(url_for('login')),
        'gone drop': client.get(url_for('view_file', file_id='never-existed')),
        'unknown URL': client.get('/does-not-exist'),
    }


@pytest.fixture
def ephemeral(app, monkeypatch):
    monkeypatch.setitem(app.config, 'EPHEMERAL_INSTANCE', True)


def test_a_normal_instance_shows_no_notice(client):
    for name, response in _pages(client).items():
        html = response.get_data(as_text=True)
        assert STRIP not in html, name
        assert GONE_LINE not in html, name


@pytest.mark.usefixtures('ephemeral')
def test_an_ephemeral_instance_shows_the_strip_on_every_page(client):
    for name, response in _pages(client).items():
        assert STRIP in response.get_data(as_text=True), name


@pytest.mark.usefixtures('ephemeral')
def test_only_the_gone_page_says_a_restart_may_have_lost_the_drop(client):
    pages = _pages(client)

    assert GONE_LINE in pages['gone drop'].get_data(as_text=True)
    assert GONE_LINE not in pages['login'].get_data(as_text=True)
    assert GONE_LINE not in pages['unknown URL'].get_data(as_text=True)


@pytest.mark.usefixtures('ephemeral')
def test_the_gone_page_still_does_not_reveal_why(client, file_record):
    from timestamps import now_iso
    file_record('opened-file', downloaded_at=now_iso())

    opened = client.get(url_for('view_file', file_id='opened-file'))
    missing = client.get(url_for('view_file', file_id='never-existed'))

    assert opened.get_data() == missing.get_data()


@pytest.mark.usefixtures('ephemeral')
def test_the_notice_is_in_polish_for_a_polish_reader(client):
    html = client.get(url_for('view_file', file_id='never-existed'),
                      headers={'Accept-Language': 'pl'}).get_data(as_text=True).replace(' ', ' ')

    assert 'Ta instancja nie zachowuje danych po restarcie.' in html
    assert 'Przesyłka mogła zniknąć przy restarcie tej instancji.' in html
