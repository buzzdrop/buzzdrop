"""Timestamps are UTC instants, whatever zone the host runs in (#250)."""
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from timestamps import (
    legacy_to_stored,
    now_iso,
    parse_expiry,
    parse_timestamp,
    to_utc_iso,
    utcnow,
)


def test_the_suite_runs_on_a_host_that_is_not_on_warsaw_time():
    # conftest pins TZ, so a naive datetime.now() can't pass for UTC or
    # for Warsaw time without a test noticing.
    offset = datetime.now().astimezone().utcoffset()
    assert offset not in (timedelta(0), timedelta(hours=1), timedelta(hours=2))


def test_utcnow_is_the_current_instant_in_utc():
    before = time.time()
    now = utcnow()
    assert now.tzinfo is timezone.utc
    # datetime keeps microseconds, time.time() more: allow for the rounding.
    assert before - 0.001 <= now.timestamp() <= time.time() + 0.001


def test_stored_timestamps_carry_the_utc_offset_at_a_fixed_width():
    stamp = now_iso()
    assert stamp.endswith('+00:00')
    # Microseconds always present, so stored values sort as text.
    assert len(stamp) == len('2026-01-01T00:00:00.000000+00:00')


def test_to_utc_iso_converts_an_aware_time_and_refuses_a_naive_one():
    warsaw_evening = datetime(2026, 10, 8, 21, 0, tzinfo=timezone(timedelta(hours=2)))
    assert to_utc_iso(warsaw_evening) == '2026-10-08T19:00:00.000000+00:00'
    with pytest.raises(ValueError):
        to_utc_iso(datetime(2026, 10, 8, 21, 0))


def test_text_order_of_stored_values_is_time_order():
    early = datetime(2026, 10, 8, 19, 0, tzinfo=timezone.utc)
    late = early + timedelta(microseconds=1)
    assert to_utc_iso(early) < to_utc_iso(late)


def test_parse_timestamp_reads_a_stored_value_as_an_aware_instant():
    assert parse_timestamp('2026-10-08T19:00:00+00:00') == datetime(
        2026, 10, 8, 19, 0, tzinfo=timezone.utc)
    # Every stored value is UTC; one still missing its offset is read as UTC
    # too, never as the host's zone.
    assert parse_timestamp('2026-10-08T19:00:00') == datetime(
        2026, 10, 8, 19, 0, tzinfo=timezone.utc)
    assert parse_timestamp(None) is None
    assert parse_timestamp('') is None
    with pytest.raises(ValueError):
        parse_timestamp('not a time')


def test_parse_expiry_takes_an_exact_moment_and_stores_it_in_utc():
    assert parse_expiry('2026-10-08T21:00+02:00') == '2026-10-08T19:00:00.000000+00:00'
    assert parse_expiry('2026-10-08T19:00:00.000Z') == '2026-10-08T19:00:00.000000+00:00'


@pytest.mark.parametrize('raw', ['2026-10-08T21:00', '2026-10-08', 'tomorrow', ''])
def test_parse_expiry_refuses_a_time_without_an_offset(raw):
    # A wall-clock time without a zone can't be pinned to an instant.
    with pytest.raises(ValueError):
        parse_expiry(raw)


def test_legacy_to_stored_reads_a_value_without_a_zone_in_the_zone_it_was_written_in():
    # A Passenger host on Warsaw time wrote 21:00 local, i.e. 19:00 UTC.
    assert legacy_to_stored('2026-10-08T21:00:00.123456', ZoneInfo('Europe/Warsaw')) \
        == '2026-10-08T19:00:00.123456+00:00'
    assert legacy_to_stored('2026-10-08T21:00:00', ZoneInfo('UTC')) \
        == '2026-10-08T21:00:00.000000+00:00'


def test_legacy_to_stored_defaults_to_the_host_zone():
    # conftest's host clock is New York: EDT, UTC-4, in October.
    assert legacy_to_stored('2026-10-08T21:00:00', None) == '2026-10-09T01:00:00.000000+00:00'


def test_legacy_to_stored_brings_an_offset_value_to_the_stored_form():
    # An expiry kept with the offset the uploader sent sorts wrongly as text
    # next to UTC values.
    assert legacy_to_stored('2026-10-08T21:00:00+02:00', None) == '2026-10-08T19:00:00.000000+00:00'


def test_legacy_to_stored_leaves_stored_and_unreadable_values_alone():
    assert legacy_to_stored('2026-10-08T19:00:00.000000+00:00', None) is None
    # Not a timestamp: the fail-closed checks treat it as expired, so it
    # keeps its value.
    assert legacy_to_stored('garbage', None) is None
    assert legacy_to_stored(None, None) is None
