"""
The drop-opened email is written in the sender's language (#293): the
language their upload was served in, stored with the drop. A Bearer
upload has no page language and stores DEFAULT_LANGUAGE; a stored
language the server no longer serves falls back to DEFAULT_LANGUAGE.
"""
import base64
import io

import pytest
from flask import url_for

from auth import get_users
from conftest import ticket_headers


def login_user(client):
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})
    with client.session_transaction() as session:
        session['csrf_token'] = 'test-csrf-token'


@pytest.fixture
def sent_messages(app, monkeypatch):
    monkeypatch.setenv('FLASK_USER_1', 'testuser:password:false:testuser@example.com')
    get_users.cache_clear()
    app.config.update({
        'SMTP_HOST': 'smtp.example.com',
        'SMTP_FROM_EMAIL': 'buzzdrop@example.com',
    })
    messages = []
    monkeypatch.setattr('app._send_email',
                        lambda recipient, subject, body: messages.append((recipient, subject, body)))
    return messages


@pytest.fixture
def open_drop(client, claim_ticket):
    """Open a drop and report its decryption, which sends the email."""
    def _open(file_id, receipt, success=True):
        client.get(url_for('download_file', file_id=file_id),
                   headers=ticket_headers(claim_ticket(file_id)))
        response = client.post(url_for('report_decryption', file_id=file_id),
                               json={'success': success, 'receipt': receipt})
        assert response.status_code == 200
    return _open


def _notify_form(name='plan.txt'):
    return {'file': (io.BytesIO(b'content'), name), 'notify_on_open': 'true'}


def test_polish_upload_gets_a_polish_email(client, files_store, sent_messages,
                                           key_release_upload, open_drop):
    login_user(client)
    file_id, _h, receipt, response = key_release_upload(
        data=_notify_form(),
        headers={'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': 'pl-PL,pl;q=0.9'})
    assert response.status_code == 200
    assert files_store.get_by_id(file_id)['language'] == 'pl'

    open_drop(file_id, receipt)

    [(_recipient, subject, body)] = sent_messages
    assert subject == 'Buzzdrop: otwarto plik'
    assert 'plan.txt' not in subject
    assert 'Typ: Plik' in body
    assert 'Odszyfrowanie: udane' in body
    # The web's full time, in Polish and DEFAULT_TIMEZONE (Europe/Warsaw
    # in the tests), its zone named: "6 sty 2025, 21:35 CET".
    opened = next(line for line in body.splitlines() if line.startswith('Otwarto: '))
    assert opened.endswith((' CET', ' CEST'))
    assert any(month in opened for month in (
        'sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'))
    assert 'Opened at' not in body


def test_language_menu_choice_wins_over_accept_language(client, files_store, sent_messages,
                                                         key_release_upload, open_drop):
    # Picking Polski in the language menu sets the ``lang`` cookie; it beats
    # the browser's English Accept-Language, so the email is Polish.
    login_user(client)
    client.set_cookie('lang', 'pl')
    file_id, _h, receipt, response = key_release_upload(
        data=_notify_form(),
        headers={'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': 'en-US,en;q=0.9'})
    assert response.status_code == 200
    assert files_store.get_by_id(file_id)['language'] == 'pl'

    open_drop(file_id, receipt)

    [(_recipient, subject, _body)] = sent_messages
    assert subject == 'Buzzdrop: otwarto plik'


def test_bearer_upload_gets_the_default_language(app, client, files_store, sent_messages,
                                                 key_release_upload, open_drop):
    with app.app_context():
        from tokens import generate_api_token
        token = generate_api_token('testuser')
    file_id, _h, receipt, response = key_release_upload(
        data=_notify_form(),
        headers={'Authorization': f'Bearer {token}', 'X-Requested-With': 'XMLHttpRequest',
                 'Accept-Language': 'pl'})
    assert response.status_code == 200
    assert files_store.get_by_id(file_id)['language'] == 'en'

    open_drop(file_id, receipt)

    [(_recipient, subject, body)] = sent_messages
    assert subject == 'Buzzdrop file opened'
    assert 'Decryption status: successful' in body


def test_removed_language_falls_back_to_the_default(app, client, files_store, sent_messages,
                                                    key_release_upload, open_drop):
    login_user(client)
    file_id, _h, receipt, _response = key_release_upload(
        data=_notify_form(),
        headers={'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': 'pl'})
    assert files_store.get_by_id(file_id)['language'] == 'pl'

    languages = app.config['LANGUAGES']
    app.config['LANGUAGES'] = ['en']
    try:
        open_drop(file_id, receipt)
    finally:
        app.config['LANGUAGES'] = languages

    [(_recipient, subject, body)] = sent_messages
    assert subject == 'Buzzdrop file opened'
    assert 'Opened at: ' in body


def test_a_note_is_called_a_note(client, files_store, sent_messages,
                                 key_release_upload, open_drop):
    login_user(client)
    file_id, _h, receipt, _response = key_release_upload(data={
        'type': 'text', 'note_text': base64.b64encode(b'Test note').decode(), 'notify_on_open': 'true',
    })

    open_drop(file_id, receipt, success=False)

    [(_recipient, subject, body)] = sent_messages
    assert subject == 'Buzzdrop note opened'
    assert 'Type: Note' in body
    assert 'Secret Note' not in body
