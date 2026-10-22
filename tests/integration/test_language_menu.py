"""
The language menu in the header (#287): a button naming the current
language, opening a menu of every language in LANGUAGES by its native
name, each item a POST /language form back to the current page. It is
left out of the recipient's pages, where the browser picks the language.
"""
from html.parser import HTMLParser

import pytest
from flask import url_for

import i18n
from conftest import CSRF_TOKEN


class _LanguageMenu(HTMLParser):
    """The menu button, and one entry per language form the page renders."""

    def __init__(self):
        super().__init__()
        self.button = None
        self.menu = None
        self.items = []
        self._form = None
        self._item = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('aria-haspopup') == 'menu':
            self.button = attrs
        if attrs.get('role') == 'menu':
            self.menu = attrs
        if tag == 'form' and attrs.get('action') == url_for('set_language'):
            self._form = {'method': attrs.get('method'), 'fields': {}}
        elif self._form is not None and tag == 'input':
            self._form['fields'][attrs['name']] = attrs.get('value')
        elif self._form is not None and tag == 'button':
            self._item = {**self._form, 'button': attrs, 'text': ''}

    def handle_data(self, data):
        if self._item is not None:
            self._item['text'] += data

    def handle_endtag(self, tag):
        if tag == 'button' and self._item is not None:
            self._item['text'] = self._item['text'].strip()
            self.items.append(self._item)
            self._item = None
        elif tag == 'form':
            self._form = None


def _menu(response):
    parser = _LanguageMenu()
    parser.feed(response.get_data(as_text=True))
    return parser


def _log_in(client):
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
    # Logging in starts a new session; seed its CSRF token again.
    with client.session_transaction() as session:
        session['csrf_token'] = CSRF_TOKEN


def test_the_button_names_the_current_language(client):
    menu = _menu(client.get(url_for('login')))

    assert menu.button['aria-label'] == 'Language: English'
    assert menu.button['aria-controls'] == menu.menu['id']


def test_the_menu_lists_every_language_by_its_native_name(client):
    menu = _menu(client.get(url_for('login')))

    assert [(item['text'], item['button']['lang']) for item in menu.items] == [
        ('English', 'en'), ('Polski', 'pl')]
    assert all(item['button']['role'] == 'menuitemradio' for item in menu.items)


def test_the_current_language_is_checked(client):
    menu = _menu(client.get(url_for('login'), headers={'Accept-Language': 'pl'}))

    assert [item['button']['aria-checked'] for item in menu.items] == ['false', 'true']
    assert menu.button['aria-label'] == 'Język: Polski'


def test_each_item_posts_its_language_back_to_this_page(client):
    menu = _menu(client.get(url_for('how_it_works', sender='cli')))

    assert [item['method'] for item in menu.items] == ['post', 'post']
    assert [item['fields'] for item in menu.items] == [
        {'csrf_token': CSRF_TOKEN, 'lang': code, 'next': '/how-it-works?sender=cli'}
        for code in ('en', 'pl')]


def test_picking_an_item_switches_the_language(client):
    item = _menu(client.get(url_for('login'))).items[1]

    client.post(url_for('set_language'), data=item['fields'])

    assert client.get(url_for('login')).headers['Content-Language'] == 'pl'


@pytest.mark.parametrize('page', ['login', 'how_it_works', 'not found'])
def test_the_menu_is_on_the_senders_pages(client, page):
    path = '/does-not-exist' if page == 'not found' else url_for(page)

    assert _menu(client.get(path)).button is not None


def test_the_menu_is_on_the_logged_in_pages(client):
    _log_in(client)

    assert _menu(client.get(url_for('index'))).button is not None


def test_the_menu_is_not_on_the_recipients_pages(client, bound_share, file_record):
    file_id = file_record()
    bound_share(file_id)

    view = client.get(url_for('view_file', file_id=file_id))
    confirm = client.post(url_for('confirm_view_file', file_id=file_id),
                          data={'csrf_token': CSRF_TOKEN})

    assert view.status_code == confirm.status_code == 200
    for response in (view, confirm):
        menu = _menu(response)
        assert (menu.button, menu.menu, menu.items) == (None, None, [])


@pytest.mark.parametrize('method', ['GET', 'POST'])
def test_the_menu_is_not_on_the_drop_is_gone_page(client, method):
    if method == 'GET':
        response = client.get(url_for('view_file', file_id='never-existed'))
    else:
        response = client.post(url_for('confirm_view_file', file_id='never-existed'),
                               data={'csrf_token': CSRF_TOKEN})

    assert response.status_code == 404
    assert _menu(response).button is None


def test_with_one_language_there_is_no_menu(app, client):
    app.config['LANGUAGES'] = ['en']
    try:
        assert _menu(client.get(url_for('login'))).button is None
    finally:
        app.config['LANGUAGES'] = ['en', 'pl']


@pytest.mark.parametrize('code, name', [('en', 'English'), ('pl', 'Polski'), ('de', 'Deutsch')])
def test_a_language_is_named_in_itself(code, name):
    assert i18n.native_name(code) == name


def test_a_page_rendered_from_a_post_only_route_goes_back_home(client, key_release_upload):
    _log_in(client)
    *_, response = key_release_upload(xhr=False)

    assert response.status_code == 200
    assert 'File is in the hive' in response.get_data(as_text=True)
    assert {item['fields']['next'] for item in _menu(response).items} == {'/'}


def test_a_page_rendered_from_a_post_to_a_get_route_goes_back_to_it(client):
    response = client.post(url_for('login'), data={'username': 'testuser', 'password': 'nope'})

    assert {item['fields']['next'] for item in _menu(response).items} == {'/login'}
