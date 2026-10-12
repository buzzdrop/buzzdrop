"""
i18n.py (#263, #265): the Polish non-breaking-space wrapper, the startup
check on LANGUAGES/DEFAULT_LANGUAGE, and the rule that flashed text is
translated eagerly.
"""
import ast
from pathlib import Path

import pytest

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
