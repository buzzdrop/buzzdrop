"""
Timestamps for Buzzdrop: every stored time is a UTC instant (#250).

Values are written as ISO 8601 with a ``+00:00`` offset and always with
microseconds, so they are the same width and their text order is their
time order: the SQL comparisons on them (``purge_expired``,
``purge_stale_key_shares``, ``claim_download``) work on the strings.
Nothing here depends on the host's zone. Text for a reader is formatted
elsewhere: in the viewer's zone by the browser, in ``DEFAULT_TIMEZONE``
for notification emails.
"""
from datetime import datetime, timezone, tzinfo
from typing import Optional


def utcnow() -> datetime:
    """The current instant, in UTC."""
    return datetime.now(timezone.utc)


def to_utc_iso(moment: datetime) -> str:
    """An aware datetime as the stored form. Refuses a naive one: there is
    no telling which instant it means."""
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError('a timestamp needs a time zone')
    return moment.astimezone(timezone.utc).isoformat(timespec='microseconds')


def now_iso() -> str:
    """The current instant in the stored form."""
    return to_utc_iso(utcnow())


def parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    """A stored value as an aware datetime, None when unset. Every value is
    written in UTC, so one without an offset (left by a version before
    #250 and not migrated) is read as UTC too, never as the host's zone.
    Raises ValueError on a value that isn't a timestamp."""
    if not value:
        return None
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def parse_expiry(raw: str) -> str:
    """An uploader's expiry as the stored form. It must name an exact
    moment, an ISO time with an offset (the browser sends
    ``Date.toISOString()``): a wall-clock time alone would be read in
    whatever zone the server runs in. Raises ValueError otherwise."""
    # 'Z' by hand: fromisoformat takes it only from Python 3.11.
    if raw[-1:] in ('Z', 'z'):
        raw = raw[:-1] + '+00:00'
    return to_utc_iso(datetime.fromisoformat(raw))


def legacy_to_stored(value: object, legacy_zone: Optional[tzinfo]) -> Optional[str]:
    """The stored form of a value left by a version before #250, or None
    when it needs no change (already stored form, unset, or not a
    timestamp at all). Those versions wrote the host's wall-clock time with
    no zone, so a naive value is read in ``legacy_zone``, the zone the host
    was on, which the code can't tell; None means the host's zone now. A
    value with an offset (an expiry kept as the uploader sent it) is only
    converted to UTC."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = (moment.astimezone() if legacy_zone is None
                  else moment.replace(tzinfo=legacy_zone))
    stored = to_utc_iso(moment)
    return None if stored == value else stored
