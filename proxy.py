"""
The real client IP and scheme behind a host's proxy (#377, #422).

Behind a proxy every request comes from the proxy's address, so everyone
shares one rate-limit bucket and drop links come out as http://. The
deployer picks one setting, never both (Config.validate refuses that):

- ``TRUSTED_PROXY_HOPS=N``: Werkzeug's ProxyFix trusts the last N entries
  of ``X-Forwarded-For`` and ``X-Forwarded-Proto``. Entries a client adds
  sit further left and are ignored. ``X-Forwarded-Host``/``Port`` are
  never trusted.
- ``CLIENT_IP_HEADER=<name>``: the client IP is that one header, which the
  host overwrites (Render's ``True-Client-IP``). ``X-Forwarded-For`` is
  ignored. The scheme still comes from ``X-Forwarded-Proto`` with one hop:
  hosts send it single-valued, so more hops would drop it.
- Neither: ``REMOTE_ADDR`` only, which a client can't spoof.

``Forwarded`` is never read: hosts pass it through as the client sent it.
Everything downstream (the limiter, stored IPs, logs) reads
``request.remote_addr``, so this is the one place that decides it.
"""
import ipaddress
import logging

from werkzeug.middleware.proxy_fix import ProxyFix

logger = logging.getLogger(__name__)

# The image's HEALTHCHECK and hosts' health checks (app.py's /healthz).
HEALTH_PATH = '/healthz'


def _environ_key(header: str) -> str:
    return 'HTTP_' + header.strip().upper().replace('-', '_')


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


class ClientIPHeader:
    """
    Take REMOTE_ADDR from one host-set header.

    A request without a usable value keeps its REMOTE_ADDR, and the first
    such request logs a warning: the header name may be wrong for this host.
    Health probes don't count: they come from inside the host, not through
    the proxy that sets the header.
    """

    def __init__(self, app, header: str):
        self.app = app
        self.header = header
        self.key = _environ_key(header)
        self._warned = False

    def __call__(self, environ, start_response):
        value = environ.get(self.key, '').strip()
        if _is_ip(value):
            environ['buzzdrop.proxy.orig_remote_addr'] = environ.get('REMOTE_ADDR')
            environ['REMOTE_ADDR'] = value
        elif not self._warned and environ.get('PATH_INFO') != HEALTH_PATH:
            self._warned = True
            logger.warning(
                'CLIENT_IP_HEADER=%s: a request arrived without a usable %s, '
                'so its client IP is the proxy address %s. Check the header '
                'name for this host.',
                self.header, self.header, environ.get('REMOTE_ADDR'))
        return self.app(environ, start_response)


class UntrustedProxyWarning:
    """
    With no proxy setting, warn once when a request looks proxied.

    Its X-Forwarded-For is ignored, as it should be, but then every client
    shares the proxy's rate-limit bucket.
    """

    def __init__(self, app):
        self.app = app
        self._warned = False

    def __call__(self, environ, start_response):
        if not self._warned and environ.get('HTTP_X_FORWARDED_FOR'):
            self._warned = True
            logger.warning(
                'A request carried X-Forwarded-For, but neither '
                'TRUSTED_PROXY_HOPS nor CLIENT_IP_HEADER is set: every client '
                'behind this proxy shares one rate limit, and drop links may '
                'come out as http://. Set the one that fits your host '
                '(docs/dev/configuration.md).')
        return self.app(environ, start_response)


def wrap(wsgi_app, hops: int, header):
    """Return wsgi_app behind the proxy handling the settings ask for."""
    if header:
        # The IP from the header; the scheme from X-Forwarded-Proto, one hop.
        return ProxyFix(ClientIPHeader(wsgi_app, header), x_for=0, x_proto=1,
                        x_host=0, x_port=0, x_prefix=0)
    if hops > 0:
        return ProxyFix(wsgi_app, x_for=hops, x_proto=hops,
                        x_host=0, x_port=0, x_prefix=0)
    return UntrustedProxyWarning(wsgi_app)
