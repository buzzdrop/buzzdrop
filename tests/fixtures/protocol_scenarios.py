"""
The protocol scenarios the JS protocol fake is held to.

Each scenario is a named request sequence that ``record_protocol_contract.py``
replays against a fresh server, recording every response into
``tests/js/fixtures/protocol-contract.json``; the JS contract test replays
the same requests against the fake and must get the same answers
(docs/frontend-test-strategy.md §6).

A scenario is a dict:

- ``name``: unique, kebab-case.
- ``config``: optional ``app.config`` overrides for this scenario only
  (``KEY_RELEASE_MAX_ATTEMPTS``, ``KEY_RELEASE_BURN_ON_LOCKOUT``,
  ``KEY_RELEASE_DOWNLOAD_TTL_SECONDS``, ``MAX_CONTENT_LENGTH``, the rate
  limits).
- ``steps``: the requests, in order. A step is a dict with ``name``,
  ``method`` and ``path``, and optionally ``headers``, ``json`` (a JSON
  body), ``form`` (multipart fields), ``files`` (multipart files, as
  ``{field: {"filename": ..., "content": <text>}}``), ``as`` (the
  account the step is sent as; default ``testuser``, ``None`` for an
  anonymous request) and ``injected`` (see below).

A later step refers to an earlier step's JSON response field with
``{"$ref": "<step>.<field>"}``, anywhere in ``path`` (a list of parts) or
in a ``json``/``form`` value.

``injected: True`` marks a response the fake cannot produce from its own
state (413, rate-limit 429, a disallowed file type): the fake's replay
injects it with ``failNext(route, status)``, which defaults to this
recorded body.

The server never checks crypto, so verifiers and receipt hashes are fixed
64-hex dummies; the one receipt that must hash to a stored
``receipt_hash`` is ``RECEIPT``.
"""
import base64
import hashlib

from fixture_env import CSRF_TOKEN

V = '11' * 32
WRONG_V = '22' * 32
RECEIPT = '33' * 32
RECEIPT_HASH = hashlib.sha256(bytes.fromhex(RECEIPT)).hexdigest()
WRONG_RECEIPT = '44' * 32
FILE_CONTENT = 'BKV3 dummy ciphertext'
NOTE_BYTES = b'BKV3 dummy note ciphertext'
# An expiry is an exact moment: the page sends Date.toISOString() (#250).
PAST_EXPIRY = '2000-01-01T00:00:00.000Z'
MISSING_ID = '00000000-0000-4000-8000-00000000dead'

# What the browser sends: index-page.js sets both on begin and on the
# upload XHR; view-page.js sets X-Requested-With on /release only.
XHR = {'X-Requested-With': 'XMLHttpRequest'}
SESSION_XHR = {**XHR, 'X-CSRF-Token': CSRF_TOKEN}
JSON_XHR = {**XHR, 'Content-Type': 'application/json'}
JSON = {'Content-Type': 'application/json'}
# The dropzone flow's wire shapes (index-page's createDropzone, the
# respond page's submit XHR and collectDropzone): create is JSON + the
# session CSRF header, release JSON + XHR + CSRF, delete the CSRF header
# alone, submit a bare-XHR multipart form, report bare JSON.
JSON_SESSION = {**JSON, 'X-CSRF-Token': CSRF_TOKEN}
JSON_SESSION_XHR = {**JSON_XHR, 'X-CSRF-Token': CSRF_TOKEN}
CSRF_ONLY = {'X-CSRF-Token': CSRF_TOKEN}

# Dropzone material (the server never checks dropzone crypto either):
# a 32-hex salt, 120-hex wrapped keys (iv 12 ‖ AES-GCM(32B) = 60 bytes),
# 64-hex verifiers, and blobs carrying the BKD1 magic /submit checks.
DZ_SALT = 'aa' * 16
DZ_WS = 'bb' * 60
DZ_V = 'cc' * 32
DZ_SV = 'dd' * 32
DZ_WRONG_SV = '55' * 32
DZ_WK = 'ee' * 60
DZ_BLOB = 'BKD1 dummy submission ciphertext'
DZ_NOTE = 'BKD1 dummy note ciphertext'
DZ_BAD_BLOB = 'XXXX not a BKD1 envelope'


def ref(field):
    return {'$ref': field}


def ticket_of(release_step):
    """The download ticket a release minted — derived (HKDF of the
    released H) by the recorder, exactly as the client derives it; it is
    never part of a response body."""
    return {'$ticket': release_step}


def file_id(share):
    """The file_id a ``share`` step minted, or ``share`` itself if it is a literal ID."""
    return share if share == MISSING_ID else ref(f'{share}.file_id')


def begin(name='begin', **extra):
    return {'name': name, 'method': 'POST', 'path': ['/upload/begin'],
            'headers': SESSION_XHR, **extra}


def upload_file(name='upload', share='begin', verifier=V, **form):
    return {
        'name': name, 'method': 'POST', 'path': ['/upload'], 'headers': SESSION_XHR,
        'form': {'file_id': ref(f'{share}.file_id'), 'key_verifier': verifier,
                 'receipt_hash': RECEIPT_HASH, **form},
        'files': {'file': {'filename': 'report.pdf', 'content': FILE_CONTENT}},
    }


def upload_note(name='upload', share='begin'):
    return {
        'name': name, 'method': 'POST', 'path': ['/upload'], 'headers': SESSION_XHR,
        'form': {'note_text': base64.b64encode(NOTE_BYTES).decode(), 'type': 'text',
                 'file_id': ref(f'{share}.file_id'), 'key_verifier': V,
                 'receipt_hash': RECEIPT_HASH},
    }


def download(name='download', share='begin', ticket=None, xhr=False):
    headers = dict(XHR) if xhr else {}
    if ticket is not None:
        headers['X-Download-Ticket'] = ticket
    step = {'name': name, 'method': 'GET', 'as': None,
            'path': ['/download/', file_id(share)]}
    if headers:
        step['headers'] = headers
    return step


def release(name='release', share='begin', v=V):
    return {'name': name, 'method': 'POST', 'as': None, 'headers': JSON_XHR,
            'path': ['/release/', file_id(share)], 'json': {'v': v}}


def report(name='report', share='begin', **body):
    return {'name': name, 'method': 'POST', 'as': None, 'headers': JSON,
            'path': ['/report_decryption/', file_id(share)],
            'json': {'success': True, 'receipt': RECEIPT, **body}}


def collect_ticket_of(release_step):
    """The X-Collect-Ticket a dropzone release mints — HKDF of the
    released wS, derived by the recorder exactly as the client derives
    it; like the download ticket, it is never part of a response body."""
    return {'$collect_ticket': release_step}


def dz_id(zone):
    """The dropzone_id a ``create`` step minted, or ``zone`` itself if it
    is a literal ID."""
    return zone if zone == MISSING_ID else ref(f'{zone}.dropzone_id')


def dz_create(name='create', **body):
    """POST /api/dropzones as the requester — the browser sends the
    derived {salt, wS, V, SV} plus options; s stays in the link fragment."""
    payload = {'salt': DZ_SALT, 'ws': DZ_WS, 'v': DZ_V, 'sv': DZ_SV}
    payload.update(body)
    return {'name': name, 'method': 'POST', 'path': ['/api/dropzones'],
            'headers': JSON_SESSION, 'json': payload}


def dz_list(name='list'):
    return {'name': name, 'method': 'GET', 'path': ['/api/dropzones'],
            'headers': XHR}


def dz_get(name='get', zone='create'):
    return {'name': name, 'method': 'GET', 'headers': XHR,
            'path': ['/api/dropzones/', dz_id(zone)]}


def dz_submit(name='submit', zone='create', sv=DZ_SV, blob=DZ_BLOB,
              sub_type='file', **form):
    """The responder's anonymous multipart POST — ``blob`` is the file's
    content (or the note's pre-base64 bytes); None sends no file part."""
    step = {'name': name, 'method': 'POST', 'as': None, 'headers': XHR,
            'path': ['/dropzone/', dz_id(zone), '/submit'],
            'form': {'sv': sv, 'wk': DZ_WK, 'receipt_hash': RECEIPT_HASH,
                     'type': sub_type, **form}}
    if sub_type == 'text':
        if blob is not None:
            raw = blob if isinstance(blob, bytes) else str(blob).encode()
            step['form']['note_text'] = base64.b64encode(raw).decode()
    elif blob is not None:
        step['files'] = {'file': {'filename': 'submission', 'content': blob}}
    return step


def dz_release(name='release', zone='create', v=DZ_V, **extra):
    return {'name': name, 'method': 'POST', 'headers': JSON_SESSION_XHR,
            'path': ['/dropzones/', dz_id(zone), '/release'],
            'json': {'v': v}, **extra}


def dz_submission(name='fetch', zone='create', ticket=None):
    headers = dict(XHR)
    if ticket is not None:
        headers['X-Collect-Ticket'] = ticket
    return {'name': name, 'method': 'GET', 'headers': headers,
            'path': ['/dropzones/', dz_id(zone), '/submission']}


def dz_report(name='report', zone='create', **body):
    """The requester's proof-of-decryption — public, like
    /report_decryption, but sent from the requester's session."""
    return {'name': name, 'method': 'POST', 'headers': JSON,
            'path': ['/dropzones/', dz_id(zone), '/report'],
            'json': {'success': True, 'receipt': RECEIPT, **body}}


def dz_delete(name='delete', zone='create', **extra):
    return {'name': name, 'method': 'POST', 'headers': CSRF_ONLY,
            'path': ['/dropzones/', dz_id(zone), '/delete'], **extra}


SCENARIOS = [
    # --- Happy paths -------------------------------------------------------
    {
        # Release first: the blob downloads only for the ticket the
        # winning /release minted.
        'name': 'file-round-trip',
        'steps': [begin(), upload_file(), release(),
                  download(ticket=ticket_of('release'), xhr=True),
                  report(),
                  download('download-again',
                           ticket=ticket_of('release'), xhr=True),
                  release('release-again')],
    },
    {
        'name': 'note-round-trip',
        'steps': [begin(), upload_note(), release(),
                  download(ticket=ticket_of('release'), xhr=True),
                  report()],
    },
    {
        'name': 'report-first-valid-wins',
        'steps': [begin(), upload_file(), release(), report(),
                  report('report-again', success=False)],
    },

    # --- Release: wrong password, lockout, expiry, missing -----------------
    {
        'name': 'release-wrong-v-then-right',
        'config': {'KEY_RELEASE_MAX_ATTEMPTS': 3},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  release('wrong-again', v=WRONG_V), release()],
    },
    {
        'name': 'release-lockout-burn-off',
        'config': {'KEY_RELEASE_MAX_ATTEMPTS': 2, 'KEY_RELEASE_BURN_ON_LOCKOUT': False},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  release('locking', v=WRONG_V), release('right-after-lockout')],
    },
    {
        'name': 'release-lockout-burn-on',
        'steps': [begin(), upload_file(), release('locking', v=WRONG_V),
                  release('right-after-burn')],
    },
    {
        'name': 'release-expired',
        'steps': [begin(), upload_file(expiry=PAST_EXPIRY), release('expired'),
                  release('expired-again'), download()],
    },
    {
        'name': 'release-missing-or-pending',
        'steps': [release('missing-file', share=MISSING_ID),
                  begin('begin-unfinished'),
                  release('pending', share='begin-unfinished')],
    },
    {
        'name': 'release-invalid-verifier',
        'steps': [begin(), upload_file(), release('short-v', v='abc'),
                  {**release('no-body'), 'json': None, 'headers': XHR}],
    },

    # --- Upload: enforcement -----------------------------------------------
    {
        'name': 'upload-csrf',
        'steps': [begin('begin-no-csrf', headers=XHR), begin(),
                  {**upload_file(), 'headers': XHR}],
    },
    {
        'name': 'upload-invalid-material',
        'steps': [begin(), upload_file(verifier='not-hex')],
    },
    {
        # A wall-clock expiry with no zone is refused before the share is
        # bound, so the same share still finishes with a corrected one.
        'name': 'upload-expiry-without-zone',
        'steps': [begin(), upload_file('no-zone', expiry='2099-01-01T00:00'),
                  upload_file('garbage', expiry='next tuesday'),
                  upload_file(expiry='2099-01-01T00:00:00.000Z')],
    },
    {
        'name': 'upload-refinish',
        'steps': [begin(), upload_file(), upload_note('refinish')],
    },
    {
        'name': 'upload-unknown-share',
        'steps': [{**upload_file(), 'form': {
            'file_id': MISSING_ID, 'key_verifier': V, 'receipt_hash': RECEIPT_HASH}}],
    },
    {
        # Open notifications are checked before the key material: only to the
        # account's own configured email, and only when SMTP is configured.
        'name': 'upload-notify-on-open',
        'steps': [
            begin(), upload_file('no-account-email', notify_on_open='true'),
            begin('begin-notify', **{'as': 'notifyuser'}),
            {**upload_file('other-email', share='begin-notify', notify_on_open='true',
                           notification_email='other@example.test'), 'as': 'notifyuser'},
            {**upload_file('own-email', share='begin-notify', notify_on_open='true',
                           notification_email='notify@example.test'), 'as': 'notifyuser'},
        ],
    },
    {
        'name': 'upload-notify-unconfigured',
        'config': {'SMTP_HOST': None},
        'steps': [begin(**{'as': 'notifyuser'}),
                  {**upload_file(notify_on_open='true'), 'as': 'notifyuser'}],
    },
    {
        'name': 'upload-other-owner',
        'steps': [begin(**{'as': 'adminuser'}), upload_file()],
    },

    # --- Download / report edge cases --------------------------------------
    {
        'name': 'download-missing',
        'steps': [download('missing-file', share=MISSING_ID),
                  download('missing-file-xhr', share=MISSING_ID, xhr=True),
                  begin('begin-unfinished'),
                  download('pending', share='begin-unfinished')],
    },
    {
        # The blob is gated by the ticket the release mints: a bare GET on
        # a live share is a uniform 403, a released share without the
        # winner's ticket is 'claimed', and the claim consumes the ticket.
        'name': 'download-requires-ticket',
        'steps': [begin(), upload_file(),
                  download('no-ticket'),
                  download('no-ticket-xhr', xhr=True),
                  release(),
                  download('bad-ticket', ticket=WRONG_V, xhr=True),
                  download('bad-ticket-browser', ticket=WRONG_V),
                  download(ticket=ticket_of('release'), xhr=True),
                  download('again', ticket=ticket_of('release'),
                           xhr=True)],
    },
    {
        # The ticket is honoured only within KEY_RELEASE_DOWNLOAD_TTL_SECONDS
        # of the release; a zero window closes it the moment it opens, so
        # even the winner's ticket finds the drop expired.
        'name': 'download-window-closed',
        'config': {'KEY_RELEASE_DOWNLOAD_TTL_SECONDS': 0},
        'steps': [begin(), upload_file(), release(),
                  download(ticket=ticket_of('release'), xhr=True),
                  download('again', ticket=ticket_of('release'), xhr=True),
                  release('release-after')],
    },
    {
        'name': 'report-enforcement',
        'steps': [report('missing-file', share=MISSING_ID), begin(), upload_file(),
                  report('wrong-receipt', receipt=WRONG_RECEIPT),
                  report('no-success', success='yes')],
    },

    # --- Injected: body size and rate limits -------------------------------
    {
        'name': 'upload-too-large',
        'config': {'MAX_CONTENT_LENGTH': 64},
        'steps': [begin(), {**upload_file(), 'injected': True}],
    },
    {
        # The page refuses a disallowed type before sending anything, so the
        # fake takes any extension; the server's refusal is injected.
        'name': 'upload-type-not-allowed',
        'steps': [begin(), {**upload_file(), 'injected': True,
                            'files': {'file': {'filename': 'tool.exe', 'content': FILE_CONTENT}}}],
    },
    {
        'name': 'rate-limit-upload-begin',
        'config': {'UPLOAD_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), {**begin('begin-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-upload',
        'config': {'UPLOAD_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), {**upload_file('upload-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-download',
        'config': {'PUBLIC_FILE_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), download(),
                  {**download('download-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-release',
        'config': {'KEY_RELEASE_RATE_LIMIT': '1 per minute', 'KEY_RELEASE_MAX_ATTEMPTS': 3},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  {**release('release-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-report',
        'config': {'REPORT_DECRYPTION_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), report(),
                  {**report('report-limited'), 'injected': True}],
    },

    # --- Dropzones: the reversed one-shot flow (docs/adr/0001) ----------
    {
        # create → list/get → a bad-sv submit the link survives → the
        # real submit spends it → wrong-V release → release → the
        # ticket-gated one-time collect → report → delete — the dropzone
        # mirror of file-round-trip.
        'name': 'dropzone-round-trip',
        'steps': [dz_create(), dz_list(), dz_get(),
                  dz_submit('bad-sv', sv=DZ_WRONG_SV),
                  dz_submit(), dz_submit('again'),
                  dz_get('get-landed'), dz_list('list-landed'),
                  dz_submission('fetch-before-release'),
                  dz_release('wrong', v=WRONG_V), dz_release(),
                  dz_release('release-again'), dz_get('get-released'),
                  dz_submission('no-ticket'),
                  dz_submission('bad-ticket', ticket=DZ_WRONG_SV),
                  dz_submission(ticket=collect_ticket_of('release')),
                  dz_submission('collect-again',
                                ticket=collect_ticket_of('release')),
                  dz_report(), dz_report('report-again', success=False),
                  dz_delete(), dz_get('get-deleted')],
    },
    {
        # A note lands through note_text instead of the file part.
        'name': 'dropzone-note-round-trip',
        'steps': [dz_create(), dz_submit(sub_type='text', blob=DZ_NOTE),
                  dz_get(), dz_release(),
                  dz_submission(ticket=collect_ticket_of('release')),
                  dz_report()],
    },
    {
        'name': 'dropzone-create-invalid',
        'steps': [{**dz_create('bad-salt', salt='zz' * 16)},
                  {**dz_create('bad-ws', ws='short')},
                  {**dz_create('bad-v', v='cc' * 31)},
                  {**dz_create('bad-expiry', expiry='2099-01-01T00:00')},
                  {**dz_create('non-dict'), 'json': 'just-a-string'},
                  {**dz_create('no-csrf'), 'headers': JSON},
                  dz_create('notify-no-email', notify_on_submission=True),
                  {**dz_create('notify-ok', notify_on_submission=True,
                               notification_email='notify@example.test'),
                   'as': 'notifyuser'},
                  dz_create('with-expiry', expiry='2099-01-01T00:00:00.000Z',
                            memo='for the contractor'),
                  dz_get('get-with-expiry', zone='with-expiry'),
                  dz_list('list-with-expiry')],
    },
    {
        'name': 'dropzone-submit-enforcement',
        'steps': [dz_create(),
                  dz_submit('bad-sv-hex', sv='not-hex'),
                  dz_submit('bad-wk', wk='short'),
                  dz_submit('bad-receipt', receipt_hash='not-hex'),
                  dz_submit('bad-type', sub_type='bogus'),
                  dz_submit('bad-magic', blob=DZ_BAD_BLOB),
                  dz_submit('no-file', blob=None),
                  dz_submit('no-note', sub_type='text', blob=None),
                  dz_submit()],
    },
    {
        # The advisory checks precede the atomic consume: a missing zone
        # is 404, a spent link 410 consumed, a past-expiry unconsumed
        # zone 410 expired (its secrets wiped inside the transaction).
        'name': 'dropzone-submit-refusals',
        'steps': [dz_submit('missing', zone=MISSING_ID),
                  dz_create('create', expiry=PAST_EXPIRY),
                  dz_submit('expired'),
                  dz_release('release-expired')],
    },
    {
        'name': 'dropzone-release-enforcement',
        'steps': [dz_release('missing', zone=MISSING_ID),
                  dz_create(), dz_release('no-submission'),
                  {**dz_release('no-csrf'), 'headers': JSON_XHR},
                  {**dz_release('no-body'), 'json': None,
                   'headers': SESSION_XHR},
                  dz_release('bad-v', v='abc'), dz_submit(),
                  dz_release('wrong', v=WRONG_V), dz_release()],
    },
    {
        'name': 'dropzone-release-lockout',
        'config': {'DROPZONE_MAX_ATTEMPTS': 2},
        'steps': [dz_create(), dz_submit(),
                  dz_release('wrong', v=WRONG_V),
                  dz_release('locking', v=WRONG_V),
                  dz_release('right-after-lockout')],
    },
    {
        'name': 'dropzone-release-burn-on',
        'config': {'DROPZONE_MAX_ATTEMPTS': 1,
                   'DROPZONE_BURN_ON_LOCKOUT': True},
        'steps': [dz_create(), dz_submit(),
                  dz_release('locking', v=WRONG_V),
                  dz_release('right-after-burn')],
    },
    {
        # A release left uncollected past DROPZONE_COLLECT_TTL_SECONDS
        # expires the zone and deletes the submission blob; a zero
        # window closes it the moment it opens.
        'name': 'dropzone-collect-window-closed',
        'config': {'DROPZONE_COLLECT_TTL_SECONDS': 0},
        'steps': [dz_create(), dz_submit(), dz_release(),
                  dz_submission(ticket=collect_ticket_of('release')),
                  dz_submission('again', ticket=collect_ticket_of('release')),
                  dz_release('release-after')],
    },
    {
        'name': 'dropzone-report-enforcement',
        'steps': [dz_report('missing', zone=MISSING_ID),
                  dz_create(), dz_report('no-submission'), dz_submit(),
                  dz_report('bad-success', success='yes'),
                  dz_report('bad-receipt-hex', receipt='not-hex'),
                  dz_report('wrong-receipt', receipt=WRONG_RECEIPT),
                  dz_report()],
    },
    {
        'name': 'dropzone-owner-only',
        'steps': [dz_create(),
                  {**dz_get('get-other'), 'as': 'adminuser'},
                  {**dz_release('release-other'), 'as': 'adminuser'},
                  {**dz_submission('fetch-other'), 'as': 'adminuser'},
                  {**dz_delete('delete-other'), 'as': 'adminuser'},
                  {**dz_list('list-other'), 'as': 'adminuser'},
                  dz_get('get-owner')],
    },
    {
        'name': 'dropzone-delete-enforcement',
        'steps': [dz_delete('missing', zone=MISSING_ID),
                  dz_create(),
                  {**dz_delete('no-csrf'), 'headers': {}},
                  dz_delete(), dz_release('release-deleted'),
                  dz_report('report-deleted')],
    },

    # --- Dropzones: injected body size and rate limits ------------------
    {
        # The create body is small enough to stay under the limit while
        # the multipart submit trips it.
        'name': 'dropzone-submit-too-large',
        'config': {'MAX_CONTENT_LENGTH': 512},
        'steps': [dz_create(), {**dz_submit(), 'injected': True}],
    },
    {
        'name': 'rate-limit-dropzone-create',
        'config': {'UPLOAD_RATE_LIMIT': '1 per minute'},
        'steps': [dz_create(),
                  {**dz_create('create-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-dropzone-submit',
        'config': {'DROPZONE_SUBMIT_RATE_LIMIT': '1 per minute'},
        'steps': [dz_create(), dz_submit(),
                  {**dz_submit('submit-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-dropzone-release',
        'config': {'DROPZONE_RELEASE_RATE_LIMIT': '1 per minute'},
        'steps': [dz_create(), dz_submit(),
                  dz_release('wrong', v=WRONG_V),
                  {**dz_release('release-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-dropzone-report',
        'config': {'REPORT_DECRYPTION_RATE_LIMIT': '1 per minute'},
        'steps': [dz_create(), dz_submit(), dz_report(),
                  {**dz_report('report-limited'), 'injected': True}],
    },
]
