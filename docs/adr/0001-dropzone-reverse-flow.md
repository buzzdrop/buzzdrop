# ADR-0001: Dropzone — reversed flow ("send it to me, securely")

- Status: proposed
- Date: 2026-10-15
- Decided at the 2026-10-08 meeting: Dropzone ships in open source (originally planned as paid/Enterprise). This ADR records *how*, not *whether*.

## Vocabulary

`CONTEXT.md` has no terms for the reversed flow yet; the following are
proposed here and should land in the glossary when this ships:

- **Dropzone**: a user's one-time invitation to receive one drop. The
  inverse of a drop: the account holder *collects*, the anonymous
  visitor *submits*.
- **Requester**: the user who creates a dropzone. (The glossary's *sender*
  doesn't fit — the requester sends nothing.)
- **Responder**: whoever opens a request link and submits a file or note
  to the dropzone. A responder needs no account — the mirror of
  *recipient*.
- **Request link**: the one-time URL a responder opens. The analogue of a
  drop link, direction reversed.
- **Submission**: what a responder submits — one file or one note,
  encrypted in their browser. The mirror of a *drop*.
- **Submit**: what a responder does with a submission. The mirror of
  *send*.
- **Collect**: what a requester does to a submission — proves the
  dropzone password and receives it, once. The mirror of *open*.
- **Dropzone password**: a kind of *password*, for the reversed flow —
  the requester sets it at creation and it gates collection. Same role
  as a drop's password, set by the receiving side rather than the
  sending one.

## Context

Buzzdrop is strictly one-directional today: a sender encrypts, sends and
hands out a drop link; a recipient proves the password and opens the drop
once. There is no way to say "here is a box — leave your secret in it, I
will pick it up". That reversed flow is the missing half: collecting a DB
password from a contractor, a certificate from a customer, a signed
contract — without "just email it".

Requirements from the meeting notes:

- 1-to-1 first: one request link, one responder, one requester.
- Everything encrypted client-side; the server must never be able to read
  submissions.
- Later evolution (potentially paid): multi-responder request links ("dear
  employees, send your reports"), per-submission random passwords, no
  mutual visibility between responders, download limits.
- Management: flat list + private memos (already exist); per-responder
  metadata deferred until the 100–300 files scale problem is real.

## Decision

Build the reversed flow on the **existing BKV3 primitives**

### Mechanism

Two secrets and the password gate, reused.

**At dropzone creation (requester):**

1. The requester's browser draws a random dropzone secret `s`.
2. The requester picks (or generates) a dropzone password. The browser
   derives `master = PBKDF2-SHA256(password, salt, 600k)`, then
   `Kw = HKDF(master, salt, 'dz-wrap')` and `V = HKDF(master, salt, 'ver')` —
   the same KDF ladder as BKV3.
3. `s` is wrapped: `wS = AES-GCM(Kw, s)`. The browser also derives the
   submit verifier `SV = HKDF(s, 'submit')` — proof of link possession,
   one-way over a random secret, so not offline-crackable like `V`.
4. The server stores `{ dropzone_id, salt, wS, V, SV, expiry }`. It
   never sees `s` or the password.
5. The browser emits the **request link** (for the responder):
   `/d/<dropzone_id>#s=<s>` — `s` rides in the fragment and never reaches
   the server. The requester keeps nothing but the password in their head;
   the dropzone appears in their account's list. The zone carries exactly
   one link; a dead link means a new dropzone, so creation must stay
   cheap.

**At submission (responder):**

1. The responder opens the request link; the server only sees `dropzone_id`
   and marks the link consumed once a valid submission lands (one-time
   link).
2. The responder's browser draws a fresh per-submission key `K` and
   encrypts the payload under AES-GCM. The plaintext keeps BKV3's inner
   layout — `BKP-FIL2 ‖ receipt ‖ name_len ‖ name ‖ data` — but the
   envelope is a **second format**, `BKD1 ‖ iv(12) ‖ ciphertext`: BKV3's
   `salt` exists to feed the password KDF, and a random `K` has nothing
   to derive from it. Then `K` is wrapped under `s`: `wK = AES-GCM(s, K)`.
3. POST `{ dropzone_id, ct, wK, receipt_hash, sv }`, where `sv` is the
   responder's `SV` re-derived from `#s`. The server constant-time
   compares `sv` to `SV` *before* consuming the link, and the
   check-plus-consume runs in one transaction, so racing submissions
   get exactly one winner. A rejected `sv` leaves the link alive. The
   server stores ciphertext + wrapped key and can derive neither
   plaintext.

**At collection (requester):**

1. The requester opens the dropzone in their list; its single submission
   shows as `{ct, wK}`.
2. Click → password prompt → the browser derives `V` from the attempt; the
   server compares `V` and only then releases `wS` + the ciphertext —
   identical to today's "password first, ciphertext second" gating with
   `attempts`, `KEY_RELEASE_MAX_ATTEMPTS` and lockout.
3. The browser unwraps `s`, unwraps `K`, decrypts, verifies the receipt.
   The submission row is deleted on collection and the dropzone is
   spent — one-time, mirroring a drop.

### Why not asymmetric crypto

- A private key would live in one browser. Password-derived `wS` works from
  any device — key custody follows the requester's memory, not their
  localStorage.
- Symmetric wrap adds zero new primitives; asymmetric would add ECDH/OpenPGP
  as a second crypto stack to review, ship, and keep in step with the
  protocol contract and the explainer page.

### Threat model notes

- Server compromise yields ciphertexts, wrapped keys, hashes and `wS` — no
  plaintext at rest. `s` never reaches the server; this is the same
  guarantee BKV3 already makes for drops — including the same caveat:
  `V` is offline-crackable after a DB theft, so password strength is the
  last barrier. One password here gates the whole zone, so the blast
  radius is bigger than a drop's.
- A leaked request link lets a stranger consume it first (fail-visible: the
  real responder reports it broken) and would let them decrypt `wK` *if*
  they could also fetch ciphertexts — but fetch needs `V`, which the
  request link does not carry. Net damage: sabotaging one submission.
- `SV` gates submission on link possession. Without it, a bare
  `dropzone_id` — which rides in the URL path and so lands in server
  and proxy logs, unlike the `#s` fragment — would let any log reader
  burn the one-time link with a garbage `wK`. With `SV`, burning still
  requires holding the link; the residual risk is the leaked-link race
  above.
- **A request link is a bearer capability, not an identity.** Whoever holds
  it may submit — including an attacker who submits *false* credentials
  (e.g. a swapped bank account number) before the intended responder does.
  The submission arrives correctly encrypted and one-time — but false.
  Cryptography cannot fix this: authenticating an anonymous responder
  requires something the impostor lacks, and the only such thing is the
  link itself. Accepted limitation for v1; mitigations to consider later:
  a requester-issued verification word checked at submission, per-responder
  named request links (which also give free "from whom" attribution), and
  UI that presents submissions as unverified until confirmed out of
  band.
- The one-shot dropzone is what makes carrying `s` in the link safe:
  "who may submit" ≈ "who may read that one submission" holds literally,
  because the zone dies with its first submission. **This is the
  load-bearing assumption.** Any multi-use variant (extra links or
  responders on one zone) would share `s` between link holders — every
  past link holder could read every future `wK` given ciphertext access —
  so reuse needs per-link secrets or `s` rotation at collection (and, for
  multi-responder, an ephemeral-ECDH swap; WebCrypto, ~30 lines, still no
  OpenPGP). Deferred; see *Deferred* below.
- Wrong-password lockout is harsher here than in send flow: `attempts`
  and `V` are per dropzone, so a typo at the last attempt locks the
  zone — stranding a submission the responder can never re-send (their
  request link is already dead). Decide per-dropzone whether lockout
  deletes rows or just locks — `KEY_RELEASE_BURN_ON_LOCKOUT` may want a
  gentler twin for dropzones.

## Example: Ala collects a DB password from Bob

Ala (admin, has an account) needs the production DB password from Bob
(contractor, no account).

1. **Ala creates a dropzone.** Her browser draws `s`; she types
   `alamakota123#$`. The server stores `salt, wS, V, SV`. She mails
   Bob `https://buzzdrop/d/abc123#s=…`. She keeps nothing but the password.
2. **Bob opens the request link**, pastes the DB password into the respond
   page. His browser draws `K`, encrypts, wraps `K` under `s`, uploads
   `ct + wK + sv`. The request link dies.
3. **Ala opens her list**, sees a submission awaiting collection,
   clicks, types `alamakota123#$`. Her browser derives `V`; the server
   verifies and releases `wS + ct` exactly once. Her browser unwraps
   `s → K → plaintext`. Row deleted; submission collected.

A server-side attacker at any point holds `ct`, `wK`, `wS`, `V`, `SV`
— all useless without `alamakota123#$`: the password alone unwraps
`s`, and `s` unwraps the rest. The password never touches the server.

## Consequences

- Submissions are a second share format (`BKD1`), so the "BKV3 is the
  only share format" invariant and `docs/dev/share-protocol.md` must be
  updated in the implementation PR.
- New server objects: `dropzones` table (id, salt, wS, V, SV, expiry,
  requester) and dropzone submissions (ct, wK, receipt_hash; the `sv`
  field is verified then discarded).
  Reuses `file_keys`-style verifier/attempts machinery.
- New routes + a respond page → security docs, CSRF, CSP/import-map and
  protocol-contract updates per `docs/dev/security.md` and
  `tests/CLAUDE.md`.
- The explainer page (`docs/how-it-works.md`) must describe the reversed
  flow in the same PR.
- Management reuses the existing flat-list + memo machinery: a memo
  attaches to a dropzone row exactly as it does to a drop.
- i18n: respond page, password prompt, list strings.
- `CONTEXT.md` gains the vocabulary section above.
- Out of scope for v1: multi-use dropzones (a zone surviving its first
  submission — see *Deferred*), multi-responder links, per-submission
  passwords, responder metadata, download limits, submission placement
  questions (they are normal blobs — `STORAGE_BACKEND` applies
  unchanged).

## Deferred

- **Dropzone model — one-shot vs multi-use.** v1 is strictly one-shot:
  one link, one submission, zone spent. Whether a dropzone should ever
  mint another link — and the mechanism for it (`s` rotation at
  collection, per-link `wS`, or ECDH per responder) — is a product
  decision deferred to "dropzone as a feature — model decision". Until
  it lands, "collect from N people" is N dropzones: creation is meant to
  be cheap enough for that not to hurt.

## Amendments (2026-10-18)

Deltas the implementation PR (#344) made against the text above,
recorded rather than rewritten:

- **The submission row is kept on collection** — this ADR said
  "deleted on collection", which contradicts the receipt report:
  `POST /dropzones/<id>/report` lands *after* collection and writes
  `decryption_success` onto the row, so deleting it would leave the
  report nowhere to write. Collection stamps `collected_at`/
  `collected_by_ip`, NULLs `ticket_hash`, streams and deletes the
  blob; the row stays so the list shows collected/decrypted and a
  repeat collect answers `already_collected` (410).
- **Collect ticket.** `GET /dropzones/<id>/submission` requires the
  `X-Collect-Ticket` header — `HKDF` over the released `wS`, hashed
  into `ticket_hash` at the winning release, like
  `claim_download_with_ticket` does for drops. A bare session URL
  can't burn the one-shot claim.
- **Collect TTL.** A released-but-uncollected submission expires
  after `DROPZONE_COLLECT_TTL_SECONDS` (600s, same value as the
  drops' `KEY_RELEASE_DOWNLOAD_TTL_SECONDS`): the submission row is
  deleted, the secrets wiped, the blob swept. This mirrors the drop
  lifecycle; the residual "release succeeded, tab died mid-collect"
  case is accepted, as for drops.
- **Request link path is `/dropzone/<id>#s=<s>`**, not `/d/<id>` —
  self-describing, matching `/view/<id>` for drops.
- **`submitted_by_ip`** is stored on the submission — a
  server-observed audit field, the mirror of `downloaded_by_ip`. The
  "responder metadata" this ADR keeps out of scope means
  responder-supplied attribution ("from whom"), not what the server
  already sees in its logs.
- **A landed submission outlives `expiry_at`:** expiry bounds the
  submit window only (`link_consumed_at` unconsumed), so a responder
  who submitted in time never loses the submission to the
  requester's deadline.
