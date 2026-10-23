"""
Links to the Website (#371): each page under the visitor's language
prefix, with that language's slug, e.g. ``/pl/jak-to-dziala/``.

``ROUTES`` mirrors the Website's route table (``src/i18n/routes.ts`` in
``buzzdrop/website``); keep the two in step when a page is added or a
slug changes. A language the Website doesn't have links to English.
"""
from flask import current_app

from i18n import SOURCE_LANGUAGE, current_language

ROUTES = {
    'home': {'en': '', 'pl': ''},
    'how_it_works': {'en': 'how-it-works', 'pl': 'jak-to-dziala'},
}


def website_url(page, language=None):
    """
    The absolute URL of the Website's ``page`` in ``language`` (default:
    the request's), or ``''`` when ``WEBSITE_URL`` is empty, so a
    deployment without a Website renders no links to it.

    Raises:
        KeyError: for a page that isn't in ``ROUTES``
    """
    slugs = ROUTES[page]
    base = current_app.config['WEBSITE_URL'].rstrip('/')
    if not base:
        return ''
    language = language or current_language()
    if language not in slugs:
        language = SOURCE_LANGUAGE
    slug = slugs[language]
    return f'{base}/{language}/{slug}/' if slug else f'{base}/{language}/'


def init_app(app):
    app.jinja_env.globals['website_url'] = website_url
