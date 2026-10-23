"""
website.py (#371): every link to the Website carries the page's language
prefix and that language's slug, as the Website's route table has them.
"""
import pytest

from website import ROUTES, website_url


@pytest.mark.parametrize('page, language, expected', [
    ('home', 'en', 'https://buzzdrop.io/en/'),
    ('home', 'pl', 'https://buzzdrop.io/pl/'),
    ('how_it_works', 'en', 'https://buzzdrop.io/en/how-it-works/'),
    ('how_it_works', 'pl', 'https://buzzdrop.io/pl/jak-to-dziala/'),
    # A language the Website doesn't have links to English.
    ('how_it_works', 'de', 'https://buzzdrop.io/en/how-it-works/'),
])
def test_each_page_in_each_language(app, page, language, expected):
    with app.test_request_context():
        assert website_url(page, language) == expected


def test_the_request_language_by_default(app):
    with app.test_request_context(headers={'Accept-Language': 'pl'}):
        assert website_url('how_it_works') == 'https://buzzdrop.io/pl/jak-to-dziala/'


@pytest.mark.parametrize('base', ['https://example.com', 'https://example.com/'])
def test_a_custom_website(app, monkeypatch, base):
    monkeypatch.setitem(app.config, 'WEBSITE_URL', base)
    with app.test_request_context():
        assert website_url('home', 'en') == 'https://example.com/en/'


def test_no_link_without_a_website(app, monkeypatch):
    monkeypatch.setitem(app.config, 'WEBSITE_URL', '')
    with app.test_request_context():
        assert website_url('how_it_works', 'pl') == ''


def test_an_unknown_page_fails_loudly(app):
    with app.test_request_context(), pytest.raises(KeyError):
        website_url('pricing', 'en')


def test_every_page_has_every_served_language(app):
    for page, slugs in ROUTES.items():
        assert set(app.config['LANGUAGES']) <= set(slugs), page
