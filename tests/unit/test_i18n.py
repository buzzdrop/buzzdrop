"""
i18n.py (#263, #265): the Polish non-breaking-space wrapper, the startup
check on LANGUAGES/DEFAULT_LANGUAGE, the plural forms handed to page
scripts, and the rule that flashed text is translated eagerly.
"""
import ast
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest
from babel.messages.catalog import Catalog
from babel.messages.mofile import write_mo
from babel.support import Translations

import i18n
from i18n import keep_polish_orphans_attached, validate_languages

NBSP = ' '
ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('text, expected', [
    ('Pobierz plik i zamknij kartę', f'Pobierz plik i{NBSP}zamknij kartę'),
    ('W skrócie', f'W{NBSP}skrócie'),
    ('a potem', f'a{NBSP}potem'),
    # Several in a row each stay with the next word.
    ('dom i w ogrodzie', f'dom i{NBSP}w{NBSP}ogrodzie'),
    # After an opening bracket, quote or dash.
    ('(w nowej karcie)', f'(w{NBSP}nowej karcie)'),
    ('„z linkiem”', f'„z{NBSP}linkiem”'),
    ('raz – i znika', f'raz – i{NBSP}znika'),
    # Not a one-letter word, or not one of the six.
    ('Kod źródłowy', 'Kod źródłowy'),
    ('Tryb x jest', 'Tryb x jest'),
    ('ul. Długa', 'ul. Długa'),
    # Placeholders are left as they are.
    ('%(a)s i %(b)s', f'%(a)s i{NBSP}%(b)s'),
])
def test_polish_one_letter_words_keep_to_the_next_word(text, expected):
    assert keep_polish_orphans_attached(text) == expected


def test_polish_wrapper_never_touches_markup():
    text = '<a href="/x" title="a b">i link</a> w <code>o z</code>'

    assert keep_polish_orphans_attached(text) == (
        f'<a href="/x" title="a b">i{NBSP}link</a> w{NBSP}<code>o{NBSP}z</code>')


def test_languages_must_include_the_default(tmp_path):
    with pytest.raises(ValueError, match="DEFAULT_LANGUAGE 'pl' must be one of LANGUAGES"):
        validate_languages(['en'], 'pl', tmp_path)


def test_languages_must_not_be_empty(tmp_path):
    with pytest.raises(ValueError, match='at least one language'):
        validate_languages([], 'en', tmp_path)


def test_a_listed_language_needs_a_compiled_catalog(tmp_path):
    (tmp_path / 'de' / 'LC_MESSAGES').mkdir(parents=True)
    (tmp_path / 'de' / 'LC_MESSAGES' / 'messages.po').write_text('')

    with pytest.raises(ValueError, match="'de', but it has no compiled catalog"):
        validate_languages(['en', 'de'], 'en', tmp_path)


def test_the_source_language_needs_no_catalog(tmp_path):
    validate_languages(['en'], 'en', tmp_path)


def test_the_pseudo_locale_can_never_be_enabled(tmp_path):
    (tmp_path / 'xx' / 'LC_MESSAGES').mkdir(parents=True)
    (tmp_path / 'xx' / 'LC_MESSAGES' / 'messages.mo').write_bytes(b'')

    with pytest.raises(ValueError, match='pseudo-locale'):
        validate_languages(['en', 'xx'], 'en', tmp_path)


def test_the_shipped_languages_pass():
    validate_languages(['en', 'pl'], 'en')


@pytest.mark.parametrize('value, expected', [
    ('en,pl', ['en', 'pl']),
    (' en , pl ,', ['en', 'pl']),
    ('', []),
])
def test_parse_languages(value, expected):
    assert i18n.parse_languages(value) == expected


@pytest.mark.parametrize('header', [
    'pl;q=abc', ';;;', 'q=1', '*', 'x' * 5000, 'pl-PL;q=0.5, ,,en',
])
def test_language_selection_never_raises(app, header):
    with app.test_request_context('/', headers={'Accept-Language': header}):
        assert i18n.select_language() in app.config['LANGUAGES']


# --- Plural forms for page scripts (#265) ---------------------------------

def _translations(language, plurals):
    """A catalog in ``language`` holding ``plurals``: (singular, plural) → forms."""
    catalog = Catalog(locale=language)
    for ids, forms in plurals.items():
        catalog.add(ids, forms)
    buffer = BytesIO()
    write_mo(buffer, catalog)
    return Translations(fp=BytesIO(buffer.getvalue()))


def test_plural_forms_are_keyed_by_cldr_category(app, monkeypatch):
    files = ('%(count)s file', '%(count)s files')
    polish = _translations('pl', {files: ('%(count)s plik', '%(count)s pliki', '%(count)s plików')})
    monkeypatch.setattr(i18n, 'get_translations', lambda: polish)

    with app.test_request_context('/', headers={'Accept-Language': 'pl'}):
        forms = i18n.plural_forms(*files)

    # gettext's Polish formula has three forms; CLDR's "other" (fractions)
    # gets the one gettext gives a fraction.
    assert forms == {'one': '%(count)s plik', 'few': '%(count)s pliki',
                     'many': '%(count)s plików', 'other': '%(count)s plików'}


def test_plural_forms_in_english_are_the_msgids(app):
    with app.test_request_context('/'):
        forms = i18n.plural_forms('%(count)s file', '%(count)s files')

    assert forms == {'one': '%(count)s file', 'other': '%(count)s files'}


def test_plural_forms_keep_polish_one_letter_words_attached(app, monkeypatch):
    attempts = ('%(count)s attempt left', '%(count)s attempts left')
    polish = _translations('pl', {attempts: ('i %(count)s próba', 'i %(count)s próby', 'i %(count)s prób')})
    monkeypatch.setattr(i18n, 'get_translations', lambda: polish)

    with app.test_request_context('/', headers={'Accept-Language': 'pl'}):
        forms = i18n.plural_forms(*attempts)

    assert forms['one'] == f'i{NBSP}%(count)s próba'


def test_script_gettext_leaves_placeholders_for_the_page_script(app, monkeypatch):
    rejected = 'Password rejected: %(reason)s'
    polish = _translations('pl', {rejected: 'Hasło odrzucone w %(reason)s'})
    monkeypatch.setattr(i18n, 'get_translations', lambda: polish)

    with app.test_request_context('/', headers={'Accept-Language': 'pl'}):
        assert i18n.script_gettext(rejected) == f'Hasło odrzucone w{NBSP}%(reason)s'


def test_script_gettext_renders_in_a_template_without_values(app):
    with app.test_request_context('/'):
        rendered = app.jinja_env.from_string("{{ script_gettext('Strong (~%(bits)s bits).') }}").render()

    assert rendered == 'Strong (~%(bits)s bits).'


# --- flash() takes eagerly translated text (#265) -------------------------

def _flash_rule_violations(source):
    """
    Where ``source`` breaks the rule: ``lazy_gettext`` only in a
    module-level constant, and a lazy constant ``str()``-ed before it is
    flashed (a lazy flash round-trips as Markup, an XSS risk).
    """
    tree = ast.parse(source)
    module_level = set()
    lazy_constants = set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and _is_call_to(node.value, 'lazy_gettext'):
            module_level.add(id(node.value))
            lazy_constants.update(t.id for t in node.targets if isinstance(t, ast.Name))

    violations = []
    for node in ast.walk(tree):
        if _is_call_to(node, 'lazy_gettext') and id(node) not in module_level:
            violations.append(f'line {node.lineno}: lazy_gettext outside a module constant')
        if _is_call_to(node, 'flash') and node.args:
            message = node.args[0]
            if _is_call_to(message, 'lazy_gettext') or (
                    isinstance(message, ast.Name) and message.id in lazy_constants):
                violations.append(f'line {node.lineno}: lazy text flashed without str()')
    return violations


def _is_call_to(node, name):
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return (isinstance(func, ast.Name) and func.id == name) or (
        isinstance(func, ast.Attribute) and func.attr == name)


@pytest.mark.parametrize('source, problem', [
    ("flash(lazy_gettext('Hi'))", 'lazy_gettext outside a module constant'),
    ("def f():\n    X = lazy_gettext('Hi')", 'lazy_gettext outside a module constant'),
    ("GREETING = lazy_gettext('Hi')\ndef f():\n    flash(GREETING)", 'flashed without str()'),
])
def test_flash_rule_catches(source, problem):
    violations = _flash_rule_violations(source)
    assert any(problem in violation for violation in violations), violations


def test_flash_rule_allows_eager_and_str_wrapped_text():
    assert _flash_rule_violations(
        "GREETING = lazy_gettext('Hi')\n"
        "def f():\n"
        "    flash(_('Saved'), 'success')\n"
        "    flash(str(GREETING))\n") == []


@pytest.mark.parametrize('module', sorted(p.name for p in ROOT.glob('*.py')))
def test_flashed_text_is_translated_eagerly(module):
    assert _flash_rule_violations((ROOT / module).read_text(encoding='utf-8')) == []


@pytest.mark.parametrize('size, language, expected', [
    (100 * 1024 * 1024, 'en', '100 MB'),
    (100 * 1024 * 1024, 'pl', '100 MB'),
    (1536 * 1024, 'en', '1.5 MB'),
    (1536 * 1024, 'pl', '1,5 MB'),
    (2048 * 1024 * 1024, 'en', '2,048 MB'),
    (2048 * 1024 * 1024, 'pl', '2 048 MB'),
])
def test_format_size_in_binary_megabytes_with_the_languages_numbers(size, language, expected):
    assert i18n.format_size(size, language) == expected


@pytest.mark.parametrize('zone, language, expected', [
    ('Europe/Warsaw', 'pl', '6 sty 2025, 21:35 CET'),
    ('Europe/Warsaw', 'en', 'Jan 6, 2025, 21:35 GMT+1'),
    ('America/New_York', 'en', 'Jan 6, 2025, 15:35 EST'),
    ('America/New_York', 'pl', '6 sty 2025, 15:35 GMT-5'),
    ('UTC', 'pl', '6 sty 2025, 20:35 UTC'),
    ('Asia/Kolkata', 'en', 'Jan 7, 2025, 02:05 GMT+5:30'),
])
def test_format_full_time_names_the_zone_in_the_languages_format(zone, language, expected):
    moment = datetime(2025, 1, 6, 20, 35, tzinfo=timezone.utc)
    assert i18n.format_full_time(moment, zone, language) == expected
