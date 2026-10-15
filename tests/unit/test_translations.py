"""
The gettext catalogs (#268): committed files in step with the sources,
every Polish entry translated, and no template text left unwrapped.

When one of the drift checks fails, run ``python translations/catalogs.py``
(the pre-commit hook does it for you) and translate what it added.
"""
import re
import sys
import uuid
from collections import Counter
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path

import pytest
from babel.messages.pofile import read_po
from babel.support import Translations
from flask import url_for
from werkzeug.exceptions import InternalServerError

import i18n
from timestamps import now_iso

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'translations'))
import catalogs  # noqa: E402

LANGUAGES = catalogs.languages()
PLACEHOLDER = re.compile(r'%\(\w+\)\w')
INLINE_TAG = re.compile(r'</?(?:a|code|strong|em)\b[^>]*>')


@pytest.fixture(scope='module')
def template():
    return catalogs.extract()


def _committed(language):
    return catalogs.read_catalog(catalogs.po_path(language), language)


def _messages(language):
    return [message for message in _committed(language) if message.id]


def _forms(value):
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _label(message):
    return message.id if isinstance(message.id, str) else message.id[0]


def test_there_is_a_polish_catalog():
    assert 'pl' in LANGUAGES


def test_messages_pot_matches_the_sources(template):
    assert catalogs.POT_PATH.read_bytes() == catalogs.po_bytes(template), (
        'translations/messages.pot is stale: run python translations/catalogs.py')


@pytest.mark.parametrize('language', LANGUAGES)
def test_po_is_in_sync_with_the_sources(template, language):
    expected = catalogs.po_bytes(catalogs.updated(_committed(language), template))

    assert catalogs.po_path(language).read_bytes() == expected, (
        f'{language}/messages.po is out of step: run python translations/catalogs.py')


@pytest.mark.parametrize('language', LANGUAGES)
def test_mo_is_compiled_from_the_po(language):
    expected = catalogs.mo_bytes(_committed(language))

    assert catalogs.mo_path(language).read_bytes() == expected, (
        f'{language}/messages.mo is stale: run python translations/catalogs.py')


@pytest.mark.parametrize('language', LANGUAGES)
def test_every_message_is_translated(language):
    missing = [_label(message) for message in _messages(language)
               if message.fuzzy or not all(_forms(message.string))]

    assert missing == [], f'untranslated or fuzzy in {language}: {missing}'


@pytest.mark.parametrize('language', LANGUAGES)
def test_no_obsolete_entries(language):
    assert not _committed(language).obsolete
    assert '#~' not in catalogs.po_path(language).read_text(encoding='utf-8')


@pytest.mark.parametrize('language', LANGUAGES)
def test_translations_keep_placeholders_and_inline_tags(language):
    mismatched = []
    for message in _messages(language):
        sources = _forms(message.id)
        for string in _forms(message.string):
            for pattern in (PLACEHOLDER, INLINE_TAG):
                # A plural's forms may each use the singular's or the plural's.
                if all(Counter(pattern.findall(string)) != Counter(pattern.findall(source))
                       for source in sources):
                    mismatched.append((_label(message), pattern.pattern, string))

    assert mismatched == []


@pytest.mark.parametrize('msgid, msgstr', [
    ('Hello %(name)s', 'Cześć'),
    ('Read <a href="%(url)s">this</a>', 'Przeczytaj to'),
    ('<strong>Once</strong>', '<em>Raz</em>'),
])
def test_parity_check_catches(msgid, msgstr):
    assert any(Counter(pattern.findall(msgid)) != Counter(pattern.findall(msgstr))
               for pattern in (PLACEHOLDER, INLINE_TAG))


# --- Pseudo-locale: text nobody wrapped ----------------------------------
#
# Every translation in `xx` is the English text between markers, stretched.
# A converted page rendered in it must show no text outside the markers,
# except what is never translated (ALLOWED) and what the page marks
# translate="no", such as the language menu's names, each in itself (#287). The catalog is built in
# memory here; it is never committed, and LANGUAGES can't list it.

OPEN, CLOSE = '⟦', '⟧'
# Brand names, numbers and user data the pages show as they are.
ALLOWED = {'Buzzdrop', 'AGPL-3.0', 'adminuser', 'testuser'}
TRANSLATABLE_ATTRIBUTES = ('aria-label', 'title', 'placeholder', 'alt')
# Text runs on across these; any other tag ends a run of words.
INLINE_TAGS = {'a', 'abbr', 'b', 'code', 'em', 'i', 'small', 'span', 'strong', 'time'}
NOT_WORDS = re.compile(r'^[\W\d_]*$')
# Links the server renders, such as a drop link.
URL = re.compile(r'^https?://')
SURROUNDING_PUNCTUATION = '()[]{}.,:;!?"\'\u201e\u201d'


def _pseudo(text):
    return f'{OPEN}{text}{"~" * (len(text) // 3)}{CLOSE}'


@pytest.fixture
def pseudo_locale(template, monkeypatch):
    catalog = catalogs.read_catalog(catalogs.POT_PATH, 'en')
    for message in catalog:
        if message.id:
            message.string = (tuple(_pseudo(form) for form in message.id)
                              if message.pluralizable else _pseudo(message.id))
    translations = Translations(fp=BytesIO(catalogs.mo_bytes(catalog)))
    monkeypatch.setattr(i18n, 'get_translations', lambda: translations)


class _VisibleText(HTMLParser):
    """The text a reader meets: text nodes and translatable attributes."""

    def __init__(self, pending=()):
        super().__init__()
        self.pending = set(pending)
        self.text = []
        self.attributes = []
        self._skipping = 0
        # The translate="no" element we are in, and how deep in its own tag.
        self._untranslated = None
        self._untranslated_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self._break(tag)
        if tag == self._untranslated:
            self._untranslated_depth += 1
        elif self._untranslated is None and (attrs.get('translate') == 'no' or self._is_pending(attrs)):
            self._untranslated, self._untranslated_depth = tag, 1
        if tag in ('script', 'style') or self._untranslated == tag and self._untranslated_depth == 1:
            self._skipping += 1
        # translate="no" covers an element's attributes too.
        if self._untranslated is not None:
            return
        for name in TRANSLATABLE_ATTRIBUTES:
            if attrs.get(name):
                self.attributes.append(attrs[name])
        if tag == 'meta' and attrs.get('name') == 'description':
            self.attributes.append(attrs['content'])

    def _is_pending(self, attrs):
        classes = (attrs.get('class') or '').split()
        return (f"#{attrs.get('id')}" in self.pending
                or any(f'.{name}' in self.pending for name in classes))

    def handle_endtag(self, tag):
        self._break(tag)
        if tag in ('script', 'style'):
            self._skipping -= 1
        if tag == self._untranslated:
            self._untranslated_depth -= 1
            if not self._untranslated_depth:
                self._untranslated = None
                self._skipping -= 1

    def _break(self, tag):
        if tag not in INLINE_TAGS:
            self.text.append(' ')

    def handle_data(self, data):
        if not self._skipping:
            self.text.append(data)


def _outside_markers(text):
    """The words of ``text`` outside every marker pair (pairs may nest)."""
    depth, outside = 0, []
    for char in text:
        if char == OPEN:
            depth += 1
        elif char == CLOSE:
            depth -= 1
        elif depth == 0:
            outside.append(char)
    words = (word.strip(SURROUNDING_PUNCTUATION) for word in ''.join(outside).split())
    return [word for word in words
            if word not in ALLOWED and not NOT_WORDS.match(word) and not URL.match(word)]


def _unwrapped(html, pending=()):
    """The words of ``html`` outside the markers, skipping the elements
    ``pending`` names as ``#id`` or ``.class`` (parts a later issue
    converts)."""
    parser = _VisibleText(pending)
    parser.feed(html)
    # Runs of inline text join as rendered: one marker pair may span inline tags.
    found = _outside_markers(''.join(parser.text))
    for value in parser.attributes:
        found += _outside_markers(value)
    return found


def _login_page(client):
    return client.get(url_for('login'))


def _login_with_a_flash(client):
    return client.post(url_for('login'), data={'username': 'testuser', 'password': 'nope'})


def _gone_page(client):
    return client.get(url_for('view_file', file_id='never-existed'))


def _gone_page_as_admin_with_a_flash(client):
    client.post(url_for('login'), data={'username': 'adminuser', 'password': 'adminpass'})
    return _gone_page(client)


def _unknown_url(client):
    return client.get('/does-not-exist')


def _landing_page(client):
    return client.get(url_for('index'))


def _composer(client):
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
    return client.get(url_for('index'))


def _drop_list(client):
    """The composer with the drop list under it, one row per status."""
    from app import get_files_store
    store = get_files_store()
    base = {'path': 'nonexistent', 'uploaded_by': 'testuser', 'created_at': now_iso(),
            'downloaded_at': None, 'expiry_at': None, 'status': 'active', 'type': 'file'}
    store.insert({**base, 'id': str(uuid.uuid4()), 'original_name': 'secret.txt'})
    store.insert({**base, 'id': str(uuid.uuid4()), 'original_name': 'Secret Note', 'type': 'text'})
    opened = {**base, 'downloaded_at': now_iso(), 'downloaded_by_ip': '203.0.113.7', 'expiry_at': now_iso()}
    store.insert({**opened, 'id': str(uuid.uuid4()), 'original_name': 'opened.txt'})
    store.insert({**opened, 'id': str(uuid.uuid4()), 'original_name': 'decrypted.txt', 'decryption_success': True})
    store.insert({**opened, 'id': str(uuid.uuid4()), 'original_name': 'locked.txt', 'decryption_success': False})
    store.insert({**base, 'id': str(uuid.uuid4()), 'original_name': 'expired.txt', 'status': 'expired',
                  'expiry_at': now_iso()})
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
    return client.get(url_for('index'))


def _live_drop(file_type):
    """A live, unopened drop of ``file_type`` sent by testuser; its id."""
    from app import get_files_store
    file_id = str(uuid.uuid4())
    get_files_store().insert({
        'id': file_id, 'original_name': 'secret.txt', 'path': f'nonexistent/{file_id}',
        'created_at': now_iso(), 'downloaded_at': None, 'uploaded_by': 'testuser',
        'expiry_at': None, 'status': 'active', 'type': file_type,
    })
    return file_id


def _success_page(file_type):
    def render(client):
        file_id = _live_drop(file_type)
        client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
        return client.get(url_for('upload_success', file_id=file_id))
    return render


def _openable_drop(file_type):
    """A live drop of ``file_type`` whose link opens: its key share bound."""
    from app import get_files_store
    store = get_files_store()
    file_id = _live_drop(file_type)
    store.create_key_share(file_id, 'bb' * 32, created_by='testuser')
    store.bind_key_verifier(file_id, 'cc' * 32, 'aa' * 16)
    return file_id


def _confirm_page(file_type):
    def render(client):
        return client.get(url_for('view_file', file_id=_openable_drop(file_type)))
    return render


def _view_page(file_type):
    def render(client):
        file_id = _openable_drop(file_type)
        with client.session_transaction() as session:
            session['csrf_token'] = 'pseudo-locale-token'
        return client.post(url_for('confirm_view_file', file_id=file_id),
                           data={'csrf_token': 'pseudo-locale-token'})
    return render


def _users_page(client):
    """/users as an admin, with a token in its table."""
    from tokens import generate_api_token
    generate_api_token('testuser')
    client.post(url_for('login'), data={'username': 'adminuser', 'password': 'adminpass'})
    return client.get(url_for('manage_users'))


def _users_page_after_revoking(token_exists):
    """/users after the revoke form posted, with its flash: revoked, or not found."""
    def render(client):
        from tokens import generate_api_token, list_api_tokens
        generate_api_token('testuser')
        token_id = list_api_tokens()[0]['id'] if token_exists else 999_999
        client.post(url_for('login'), data={'username': 'adminuser', 'password': 'adminpass'})
        with client.session_transaction() as session:
            session['csrf_token'] = 'pseudo-locale-token'
        return client.post(url_for('revoke_api_token_route', token_id=token_id),
                           data={'csrf_token': 'pseudo-locale-token'}, follow_redirects=True)
    return render


def _users_page_refused(as_user):
    """Where /users sends someone who may not see it, with its flash: the
    login page for a visitor, the composer for a user who isn't an admin."""
    def render(client):
        if as_user:
            client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
        return client.get(url_for('manage_users'), follow_redirects=True)
    return render


def _how_it_works(client):
    """/how-it-works: the template renders every variant, hidden or not."""
    return client.get(url_for('how_it_works'))


def _how_it_works_under(max_attempts, burn_on_lockout):
    """/how-it-works under another key-release policy, whose release step,
    what we keep and limits each read differently."""
    def render(client):
        # A render gets only the client, not monkeypatch or the
        # key_release_settings fixture, so it puts the policy back itself.
        config = client.application.config
        saved = {key: config[key] for key in ('KEY_RELEASE_MAX_ATTEMPTS', 'KEY_RELEASE_BURN_ON_LOCKOUT')}
        config.update(KEY_RELEASE_MAX_ATTEMPTS=max_attempts, KEY_RELEASE_BURN_ON_LOCKOUT=burn_on_lockout)
        try:
            return client.get(url_for('how_it_works'))
        finally:
            config.update(saved)
    return render


# The pages converted so far; each i18n issue adds its own.
CONVERTED_PAGES = {
    'login': _login_page,
    'login with a flash': _login_with_a_flash,
    'drop is gone': _gone_page,
    'drop is gone, admin header and flash': _gone_page_as_admin_with_a_flash,
    'unknown URL': _unknown_url,
    'success, file': _success_page('file'),
    'success, note': _success_page('text'),
    'landing page': _landing_page,
    'composer': _composer,
    'drop list': _drop_list,
    'confirm, file': _confirm_page('file'),
    'confirm, note': _confirm_page('text'),
    'view, file': _view_page('file'),
    'view, note': _view_page('text'),
    'users': _users_page,
    'users, token revoked': _users_page_after_revoking(token_exists=True),
    'users, token not found': _users_page_after_revoking(token_exists=False),
    'users refused, logged out': _users_page_refused(as_user=False),
    'users refused, not an admin': _users_page_refused(as_user=True),
    'how it works': _how_it_works,
    'how it works, three attempts, burn': _how_it_works_under(3, burn_on_lockout=True),
    'how it works, one attempt, no burn': _how_it_works_under(1, burn_on_lockout=False),
    'how it works, three attempts, no burn': _how_it_works_under(3, burn_on_lockout=False),
}
# Parts of a converted page that a later issue converts, as #id or .class.
PENDING = {}


@pytest.mark.parametrize('page', CONVERTED_PAGES)
def test_converted_pages_have_no_unwrapped_text(client, db_instance, pseudo_locale, page):
    html = CONVERTED_PAGES[page](client).get_data(as_text=True)

    assert OPEN in html, 'the pseudo-locale is not in effect'
    assert _unwrapped(html, PENDING.get(page, ())) == []


def test_the_server_error_page_has_no_unwrapped_text(app, pseudo_locale):
    from app import handle_server_error
    with app.test_request_context('/'):
        html, _status = handle_server_error(InternalServerError())

    assert _unwrapped(html) == []


def test_the_pseudo_locale_check_catches_unwrapped_text():
    html = (f'<title>{_pseudo("Title")}</title><p>{_pseudo("Wrapped")} Unwrapped</p>'
            f'<button aria-label="Close">{_pseudo("x")}</button>'
            '<span>Buzz<b>drop</b> 404 &middot;</span>')

    assert _unwrapped(html) == ['Unwrapped', 'Close']


def test_the_pseudo_locale_check_skips_what_is_marked_untranslated():
    html = ('<p><span translate="no">Polski <span>polski</span></span> After</p>'
            '<button translate="no" lang="pl">Polski</button><b>Bold</b>'
            '<p translate="no"><a title="PDF">PDF</a></p>')

    assert _unwrapped(html) == ['After', 'Bold']


def test_the_pseudo_locale_check_skips_what_a_later_issue_converts():
    html = ('<div id="later" aria-label="Later"><p>Not yet</p><b title="Nor this">x</b></div>'
            '<p class="cap soon">Nor yet</p><p id="now">Now</p>')

    assert _unwrapped(html, pending={'#later', '.soon'}) == ['Now']
