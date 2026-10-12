"""
An expiry is an instant, whatever zone the uploader and the server are in
(#250). The suite runs on a New York host clock (conftest), the uploader
here is in Warsaw: six hours apart, so an expiry read as wall-clock time
in either zone lands hours off.
"""
import base64
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from tests.integration.test_files import login_user

WARSAW = ZoneInfo('Europe/Warsaw')


def warsaw_time(delta):
    """What an uploader in Warsaw sends: their wall-clock time as an exact
    moment, with Warsaw's offset."""
    return (datetime.now(WARSAW) + delta).isoformat(timespec='minutes')


def test_an_expiry_is_stored_as_the_instant_it_names(client, files_store, key_release_upload):
    login_user(client, 'testuser', 'password')

    file_id, _h, _rcpt, response = key_release_upload(
        data={'expiry': '2026-10-08T21:00+02:00'})

    assert response.status_code == 200
    assert files_store.get_by_id(file_id)['expiry_at'] == '2026-10-08T19:00:00.000000+00:00'


def test_an_expiry_a_minute_ago_in_warsaw_has_passed_on_this_host(client, files_store, key_release_upload):
    login_user(client, 'testuser', 'password')

    file_id, _h, _rcpt, response = key_release_upload(
        data={'expiry': warsaw_time(-timedelta(minutes=1))})
    assert response.status_code == 200

    view = client.get(f'/view/{file_id}')

    assert view.status_code == 404
    assert files_store.get_by_id(file_id)['status'] == 'expired'


def test_an_expiry_a_minute_ahead_in_warsaw_has_not_passed_on_this_host(client, files_store, key_release_upload):
    login_user(client, 'testuser', 'password')

    file_id, _h, _rcpt, response = key_release_upload(
        data={'expiry': warsaw_time(timedelta(minutes=2))})
    assert response.status_code == 200

    assert client.get(f'/view/{file_id}').status_code == 200
    assert files_store.get_by_id(file_id)['status'] == 'active'


@pytest.mark.parametrize('expiry', ['2026-10-08T21:00', 'next tuesday'])
@pytest.mark.parametrize('kind', ['file', 'text'])
def test_an_expiry_that_is_not_an_exact_moment_is_refused(
        client, files_store, key_release_upload, kind, expiry):
    login_user(client, 'testuser', 'password')
    data = {'expiry': expiry}
    if kind == 'text':
        data.update(type='text', note_text=base64.b64encode(b'BKV3' + b'\0' * 40).decode())

    file_id, _h, _rcpt, response = key_release_upload(data=data)

    assert response.status_code == 400
    assert 'time zone' in response.get_json()['error']
    # Refused before the share was bound, so nothing was stored and the
    # pending share can still be finished with a corrected expiry.
    assert files_store.get_by_id(file_id) is None
    assert files_store.get_key_share(file_id)['v'] is None
