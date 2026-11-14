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

``TRUSTED_PROXY_IPS`` (optional) limits *who may speak for a client*:
with it set, forwarded headers are honored only when the immediate peer
is in the allowlist — an attacker reaching the app around the ingress
can no longer plant a client IP. Hosts that can't enumerate their edge
(Render doesn't publish it) leave it empty and rely on the edge being
the only path; the startup warning says so.
"""
import ipaddress
import logging
import threading
from typing import Optional

from werkzeug.middleware.proxy_fix import ProxyFix

logger = logging.getLogger(__name__)

# The image's HEALTHCHECK and hosts' health checks; app.py routes it here.
HEALTH_PATH = '/healthz'


def _environ_key(header: str) -> str:
    return 'HTTP_' + header.strip().upper().replace('-', '_')


class _Once:
    """True on the first call only, across threads (per worker process)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._done = False

    def __call__(self) -> bool:
        with self._lock:
            first, self._done = not self._done, True
            return first


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
        self._first_warning = _Once()

    def __call__(self, environ, start_response):
        value = environ.get(self.key, '').strip()
        if _is_ip(value):
            environ['REMOTE_ADDR'] = value
        elif environ.get('PATH_INFO') != HEALTH_PATH and self._first_warning():
            logger.warning(
                'CLIENT_IP_HEADER=%s: a request arrived without a usable %s, '
                'so its client IP is the proxy address %s. Check the header '
                'name for this host.',
                self.header, self.header, environ.get('REMOTE_ADDR'))
        return self.app(environ, start_response)


class TrustedPeerGate:
    """
    Honor forwarded-IP headers only from allowlisted peers.

    Wraps the ProxyFix/ClientIPHeader layer: when the immediate peer
    (REMOTE_ADDR) is not in TRUSTED_PROXY_IPS, the headers that layer
    would trust are stripped from the environ before it can read them,
    so the real connection address flows through instead. One warning is
    logged the first time this happens per worker process.
    """

    def __init__(self, app, cidrs, strip_keys):
        self.app = app
        self.nets = tuple(
            ipaddress.ip_network(c, strict=False) for c in cidrs)
        self.strip_keys = strip_keys
        self._first_warning = _Once()

    def __call__(self, environ, start_response):
        peer = environ.get('REMOTE_ADDR', '')
        try:
            peer_addr = ipaddress.ip_address(peer)
            trusted = any(peer_addr in net for net in self.nets)
        except ValueError:
            trusted = False
        if not trusted:
            for key in self.strip_keys:
                environ.pop(key, None)
            if environ.get('PATH_INFO') != HEALTH_PATH and \
                    self._first_warning():
                logger.warning(
                    'TRUSTED_PROXY_IPS: a request from peer %s carried '
                    'forwarded headers; they were ignored because the peer '
                    'is not in the allowlist.', peer or '(unknown)')
        return self.app(environ, start_response)


class UntrustedProxyWarning:
    """
    With no proxy setting, warn once when a request looks proxied.

    Its X-Forwarded-For is ignored, as it should be, but then every client
    shares the proxy's rate-limit bucket.
    """

    def __init__(self, app):
        self.app = app
        self._first_warning = _Once()

    def __call__(self, environ, start_response):
        if environ.get('HTTP_X_FORWARDED_FOR') and self._first_warning():
            logger.warning(
                'A request carried X-Forwarded-For, but neither '
                'TRUSTED_PROXY_HOPS nor CLIENT_IP_HEADER is set: every client '
                'behind this proxy shares one rate limit, and drop links may '
                'come out as http://. Set the one that fits your host '
                '(docs/dev/configuration.md).')
        return self.app(environ, start_response)


def describe(hops: int, header: Optional[str]) -> str:
    """Where the client IP comes from, for the startup printout."""
    if header:
        return header
    if hops > 0:
        return f'X-Forwarded-For, {hops} hop(s)'
    return 'the connection (no proxy trusted)'


def wrap(wsgi_app, hops: int, header: Optional[str],
         trusted_ips=()):
    """Return wsgi_app behind the proxy handling the settings ask for."""
    if header:
        # The IP from the header; the scheme from X-Forwarded-Proto, one hop.
        app = ProxyFix(ClientIPHeader(wsgi_app, header), x_for=0, x_proto=1,
                       x_host=0, x_port=0, x_prefix=0)
    elif hops > 0:
        app = ProxyFix(wsgi_app, x_for=hops, x_proto=hops,
                       x_host=0, x_port=0, x_prefix=0)
    else:
        app = UntrustedProxyWarning(wsgi_app)
    if trusted_ips:
        strip_keys = {'HTTP_X_FORWARDED_FOR', 'HTTP_X_FORWARDED_PROTO'}
        if header:
            strip_keys.add(_environ_key(header))
        app = TrustedPeerGate(app, trusted_ips, strip_keys)
    return app
