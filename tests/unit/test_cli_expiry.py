"""The CLI sends an expiry only as an exact moment, in UTC (#250)."""
import argparse
import importlib.machinery
import importlib.util
import os

import pytest


def _import_buzz():
    """Import cli/buzz as a module (file has no .py extension)."""
    buzz_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..', 'cli', 'buzz'))
    loader = importlib.machinery.SourceFileLoader('buzz', buzz_path)
    spec = importlib.util.spec_from_loader('buzz', loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


buzz = _import_buzz()


@pytest.mark.parametrize('raw, sent', [
    ('2026-12-31T23:59+01:00', '2026-12-31T22:59:00.000000+00:00'),
    ('2026-12-31T22:59Z', '2026-12-31T22:59:00.000000+00:00'),
    ('2026-12-31T22:59:30.5-05:00', '2027-01-01T03:59:30.500000+00:00'),
])
def test_an_expiry_with_a_zone_is_sent_in_utc(raw, sent):
    assert buzz.expiry_argument(raw) == sent


@pytest.mark.parametrize('raw', ['2026-12-31T23:59', '2026-12-31', 'soon'])
def test_an_expiry_without_a_zone_is_refused_before_anything_is_sent(raw):
    with pytest.raises(argparse.ArgumentTypeError, match='time zone'):
        buzz.expiry_argument(raw)
