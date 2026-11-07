"""
GET /healthz: the image's HEALTHCHECK and hosts' health checks (#386).
"""


def test_healthz_answers_ok_without_a_login(client):
    response = client.get('/healthz')

    assert response.status_code == 200
    assert response.get_data(as_text=True) == 'ok\n'
    assert response.mimetype == 'text/plain'


def test_healthz_answers_503_when_the_database_fails(client, monkeypatch):
    import app as app_module

    class _DeadBackend:
        def ping(self):
            raise RuntimeError('database is gone')

    monkeypatch.setattr(app_module, 'get_backend', lambda: _DeadBackend())

    response = client.get('/healthz')

    assert response.status_code == 503
    assert response.get_data(as_text=True) == 'unavailable\n'


def test_healthz_carries_the_security_headers(client):
    response = client.get('/healthz')

    assert 'Content-Security-Policy' in response.headers
