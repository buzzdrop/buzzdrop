"""
Languages (#263, #265): which one a request is served in, and the
gettext functions the app and its templates translate through.

A request's language is a valid ``lang`` cookie, else the best
``Accept-Language`` match, else ``DEFAULT_LANGUAGE``; resolving it
never raises. Only ``POST /language`` sets the cookie. Catalogs live in
``translations/<lang>/LC_MESSAGES/messages.{po,mo}`` (one ``messages``
domain, English source text as msgids, no ``en`` catalog), and
``translations/catalogs.py`` extracts, updates and compiles them.

Translate through this module, not flask_babel: its functions also keep
Polish one-letter words off line ends (#264). ``flash()`` takes an eager
``gettext(...)``; ``lazy_gettext`` is only for module constants, and a
lazy string is wrapped in ``str()`` before it is flashed (a lazy flash
round-trips as ``Markup``). ``tests/unit/test_i18n.py`` enforces both.
"""
import re
from pathlib import Path

from babel import Locale, UnknownLocaleError
from babel.numbers import format_decimal
from flask import current_app, g, has_request_context, request
from flask_babel import Babel, get_locale, get_translations, refresh
from flask_babel.speaklater import LazyString

# The language the msgids are written in; it needs no catalog.
SOURCE_LANGUAGE = 'en'
LANGUAGE_COOKIE = 'lang'
LANGUAGE_COOKIE_MAX_AGE = 365 * 24 * 3600
TRANSLATIONS_DIR = Path(__file__).resolve().parent / 'translations'
# The pseudo-locale the unwrapped-string check renders in; generated at
# test time and never served (#268).
PSEUDO_LANGUAGE = 'xx'
# og:locale wants a territory; a language not listed here gets ll_LL.
OG_LOCALES = {'en': 'en_US', 'pl': 'pl_PL'}

# A standalone one-letter Polish word followed by a space: at the start,
# or after whitespace, an opening bracket or an opening quote.
_POLISH_ORPHAN = re.compile('(?<![^\\s(\u201e"\u2013])([aiouwzAIOUWZ]) ')
_TAG = re.compile(r'(<[^>]*>)')


def parse_languages(value):
    """``LANGUAGES`` as a list of codes: comma-separated, blanks dropped."""
    return [code.strip() for code in (value or '').split(',') if code.strip()]


def validate_languages(languages, default, translations_dir=TRANSLATIONS_DIR):
    """
    Refuse to start with a language setup that can't be served: the
    default must be listed, and every listed language other than the
    source language needs a compiled catalog.

    Raises:
        ValueError: naming what is wrong
    """
    if not languages:
        raise ValueError('LANGUAGES must list at least one language')
    if default not in languages:
        raise ValueError(
            f'DEFAULT_LANGUAGE {default!r} must be one of LANGUAGES ({", ".join(languages)})')
    for code in languages:
        if code == PSEUDO_LANGUAGE:
            raise ValueError(f'LANGUAGES must not list the test-only pseudo-locale {code!r}')
        if code == SOURCE_LANGUAGE:
            continue
        catalog = Path(translations_dir) / code / 'LC_MESSAGES' / 'messages.mo'
        if not catalog.is_file():
            raise ValueError(
                f'LANGUAGES lists {code!r}, but it has no compiled catalog at {catalog}')


def select_language():
    """
    The language this request is served in: a valid ``lang`` cookie, then
    the best ``Accept-Language`` match by base language, then
    ``DEFAULT_LANGUAGE``. Never raises; outside a request it is the default.
    """
    default = current_app.config['DEFAULT_LANGUAGE']
    if not has_request_context():
        return default
    try:
        languages = current_app.config['LANGUAGES']
        cookie = request.cookies.get(LANGUAGE_COOKIE)
        if cookie in languages:
            return cookie
        return _best_accepted_language(request.accept_languages, languages) or default
    except Exception:  # a malformed header must not cost the page
        return default


def _best_accepted_language(accepted, languages):
    """
    The first supported language in the visitor's preference order, each
    tag matched by its base language (``pl-PL`` → ``pl``). Werkzeug's
    ``best_match`` tries exact tags across the whole header first, so
    ``pl-PL,en;q=0.5`` would get ``en``.
    """
    for tag, quality in sorted(accepted, key=lambda item: item[1], reverse=True):
        base = tag.replace('_', '-').split('-')[0].lower()
        if quality > 0 and base in languages:
            return base
    return None


def current_language():
    """The language code the current request is rendered in."""
    return str(get_locale() or current_app.config['DEFAULT_LANGUAGE'])


def og_locale(language):
    """The ``og:locale`` value for a language code."""
    return OG_LOCALES.get(language, f'{language}_{language.upper()}')


def native_name(language):
    """
    A language's name in that language, capitalized as it stands alone in
    a list ("Polski", not "polski"): how a reader finds their own language.
    """
    name = Locale.parse(language).get_display_name(language)
    return name[:1].upper() + name[1:]


def language_menu(current, return_path):
    """
    What the header's language menu shows (#287): every language in
    ``LANGUAGES`` by its native name, the current one marked, and the page
    each choice goes back to. None with a single language, as there is
    nothing to choose.
    """
    languages = current_app.config['LANGUAGES']
    if len(languages) < 2:
        return None
    entries = [{'code': code, 'name': native_name(code), 'current': code == current}
               for code in languages]
    return {
        'current': next(entry for entry in entries if entry['current']),
        'languages': entries,
        'next': return_path,
    }


def format_size(size, language):
    """
    A size in bytes as binary megabytes, in the language's number format,
    with a non-breaking space before the unit in every language (#266):
    "100 MB", "1,5 MB".
    """
    return f'{format_decimal(size / 1024 / 1024, format="#,##0.#", locale=language)}\u00a0MB'


def keep_polish_orphans_attached(text):
    """
    Join each standalone one-letter word (a, i, o, u, w, z) to the next
    word with a non-breaking space, so Polish typesetting never leaves one
    at a line end (#264). Only text between tags changes, never markup.
    """
    return ''.join(
        part if part.startswith('<') else _POLISH_ORPHAN.sub('\\1\u00a0', part)
        for part in _TAG.split(text))


def _finish(text):
    if current_language() == 'pl':
        return keep_polish_orphans_attached(text)
    return text


def _translate(string):
    return _finish(get_translations().ugettext(string))


def _translate_plural(singular, plural, num):
    return _finish(get_translations().ungettext(singular, plural, num))


def _translate_in_context(context, string):
    return _finish(get_translations().upgettext(context, string))


def _translate_plural_in_context(context, singular, plural, num):
    return _finish(get_translations().unpgettext(context, singular, plural, num))


def gettext(string, **variables):
    """``string`` in the request's language, with ``%(name)s`` filled."""
    text = _translate(string)
    return text % variables if variables else text


def ngettext(singular, plural, num, **variables):
    """The plural form for ``num``; ``%(num)d`` is filled in too."""
    variables.setdefault('num', num)
    return _translate_plural(singular, plural, num) % variables


def pgettext(context, string, **variables):
    """``gettext`` for a word that needs a context to translate apart."""
    text = _translate_in_context(context, string)
    return text % variables if variables else text


def script_gettext(string):
    """
    ``string`` translated for a page script, its ``%(name)s`` placeholders
    left for ``lib/strings.js`` to fill (#265): the template's ``_()``
    would fill them, and fail without values.
    """
    return _translate(string)


def gettext_noop(string):
    """
    Mark ``string`` for extraction and return it untranslated: for a
    constant that stays English in JSON and is translated where it is shown.
    """
    return string


# Numbers tried, in order, for one that falls in each CLDR plural category.
# A category only fractions reach (Polish "other") is found by a fraction,
# but gettext counts whole numbers, so it takes the form gettext gives
# _FRACTION_COUNT: a fraction reads like "several" ("1,5 plików").
_PLURAL_SAMPLES = (*range(0, 200), 0.5, 1.5)
_FRACTION_COUNT = 5


def plural_forms(singular, plural):
    """
    The plural forms of a message for a page script to choose from, keyed
    by the language's CLDR plural categories (#265): each is the gettext
    form for a number in that category, its placeholders left unfilled.
    The script picks one with ``Intl.PluralRules`` (``lib/strings.js``),
    so no gettext plural formula reaches the browser.
    """
    try:
        rule = Locale.parse(current_language()).plural_form
    except (UnknownLocaleError, ValueError):  # the test-only pseudo-locale
        rule = Locale.parse(SOURCE_LANGUAGE).plural_form
    counts = {}
    for number in _PLURAL_SAMPLES:
        counts.setdefault(rule(number), number if isinstance(number, int) else _FRACTION_COUNT)
    return {category: _translate_plural(singular, plural, count) for category, count in counts.items()}


def lazy_gettext(string, **variables):
    """A module constant translated when used. ``str()`` it before ``flash``."""
    return LazyString(gettext, string, **variables)


def _forget_language():
    # Flask-Babel caches the locale on g, and g outlives a request when an
    # app context was already pushed (tests): resolve afresh each request.
    refresh()
    g.pop('page_language', None)


def init_app(app):
    """
    Set up Flask-Babel with the language selector and route the templates'
    ``_()``, ``{% trans %}`` and friends through this module. The language
    settings are checked first, so a bad setup stops the app at startup.
    """
    validate_languages(app.config['LANGUAGES'], app.config['DEFAULT_LANGUAGE'])
    Babel(app, locale_selector=select_language,
          default_locale=app.config['DEFAULT_LANGUAGE'],
          default_translation_directories=str(TRANSLATIONS_DIR))
    app.before_request(_forget_language)
    app.jinja_env.policies['ext.i18n.trimmed'] = True
    app.jinja_env.globals['plural_forms'] = plural_forms
    app.jinja_env.globals['format_size'] = format_size
    app.jinja_env.globals['script_gettext'] = script_gettext
    app.jinja_env.install_gettext_callables(
        gettext=_translate,
        ngettext=_translate_plural,
        pgettext=_translate_in_context,
        npgettext=_translate_plural_in_context,
        newstyle=True,
    )
