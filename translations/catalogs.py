"""
Extract, update and compile the gettext catalogs (#265, #268).

    python translations/catalogs.py

1. Extracts every message from the root Python modules and the templates
   (``babel.cfg``) into ``translations/messages.pot``.
2. Updates each ``translations/<lang>/LC_MESSAGES/messages.po`` from it:
   new messages arrive untranslated, changed ones fuzzy, removed ones are
   dropped.
3. Compiles each ``.po`` into the ``.mo`` the app reads.

All three files are committed. The pre-commit hook runs this when a
source changes, and ``tests/unit/test_translations.py`` fails while any
of them is stale, or while a Polish entry is missing or fuzzy.

Output is deterministic (fixed dates, no line numbers), so rerunning on
unchanged sources changes nothing.
"""
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from babel.messages.catalog import Catalog
from babel.messages.extract import extract_from_dir
from babel.messages.frontend import parse_mapping_cfg
from babel.messages.mofile import write_mo
from babel.messages.pofile import read_po, write_po

ROOT = Path(__file__).resolve().parents[1]
TRANSLATIONS = ROOT / 'translations'
POT_PATH = TRANSLATIONS / 'messages.pot'
DOMAIN = 'messages'
KEYWORDS = {
    '_': None,
    'gettext': None,
    'ngettext': (1, 2),
    'pgettext': ((1, 'c'), 2),
    'npgettext': ((1, 'c'), 2, 3),
    'lazy_gettext': None,
}
COMMENT_TAGS = ('Translators:',)
# A fixed date keeps the header from changing on every run.
FIXED_DATE = datetime(2026, 1, 1, tzinfo=timezone.utc)
PROJECT = 'Buzzdrop'
VERSION = '1.0'
BUGS_ADDRESS = 'https://github.com/buzzdrop/buzzdrop/issues'
HEADER_COMMENT = """\
# Buzzdrop's interface text: every message the app translates, extracted
# by translations/catalogs.py. Don't edit; rerun the script.
#"""


def _extracted_dirs(dirpath):
    """Walk only the root (for its modules) and templates/."""
    relative = Path(dirpath).resolve().relative_to(ROOT)
    return relative == Path('.') or relative.parts[0] == 'templates'


def extract():
    """A fresh template catalog extracted from the sources."""
    with open(ROOT / 'babel.cfg', encoding='utf-8') as config:
        method_map, options_map = parse_mapping_cfg(config)
    catalog = Catalog(project=PROJECT, version=VERSION, creation_date=FIXED_DATE,
                      revision_date=FIXED_DATE, fuzzy=False,
                      msgid_bugs_address=BUGS_ADDRESS, header_comment=HEADER_COMMENT)
    for filename, lineno, message, comments, context in extract_from_dir(
            ROOT, method_map, options_map, keywords=KEYWORDS,
            comment_tags=COMMENT_TAGS, directory_filter=_extracted_dirs):
        catalog.add(message, None, [(filename, lineno)],
                    auto_comments=comments, context=context)
    return catalog


def languages():
    """The language codes that have a catalog, sorted."""
    return sorted(path.parent.parent.name
                  for path in TRANSLATIONS.glob(f'*/LC_MESSAGES/{DOMAIN}.po'))


def po_path(language):
    return TRANSLATIONS / language / 'LC_MESSAGES' / f'{DOMAIN}.po'


def mo_path(language):
    return po_path(language).with_suffix('.mo')


def read_catalog(path, language=None):
    with open(path, 'rb') as file:
        return read_po(file, locale=language)


def updated(catalog, template):
    """``catalog`` brought in line with ``template``, obsolete entries dropped."""
    catalog.update(template, update_creation_date=True)
    catalog.revision_date = FIXED_DATE
    return catalog


def po_bytes(catalog):
    """A catalog as committed: no line numbers, obsolete entries dropped."""
    out = BytesIO()
    write_po(out, catalog, width=76, include_lineno=False, ignore_obsolete=True)
    return out.getvalue()


def mo_bytes(catalog):
    out = BytesIO()
    write_mo(out, catalog, use_fuzzy=False)
    return out.getvalue()


def _write_if_changed(path, data):
    if not path.exists() or path.read_bytes() != data:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f'catalogs: wrote {path.relative_to(ROOT)}')


def main():
    template = extract()
    _write_if_changed(POT_PATH, po_bytes(template))
    for language in languages():
        catalog = updated(read_catalog(po_path(language), language), template)
        po = po_bytes(catalog)
        _write_if_changed(po_path(language), po)
        _write_if_changed(mo_path(language), mo_bytes(read_po(BytesIO(po), locale=language)))


if __name__ == '__main__':
    sys.exit(main())
