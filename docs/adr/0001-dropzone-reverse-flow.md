# ADR-0001: Dropzone — reversed flow ("send it to me, securely")

- Status: proposed
- Date: 2026-10-15
- Decided at the 2026-10-08 meeting: Dropzone ships in open source (originally planned as paid/Enterprise). This ADR records *how*, not *whether*.

## Vocabulary

`CONTEXT.md` has no terms for the reversed flow yet; the following are
proposed here and should land in the glossary when this ships:

- **Dropzone**: a user's standing invitation to receive drops. The inverse
  of a drop: the account holder *receives*, the anonymous visitor *sends*.
- **Requester**: the user who creates a dropzone. (The glossary's *sender*
  doesn't fit — the requester sends nothing.)
- **Responder**: whoever opens a request link and drops a file or note into
  the dropzone. A responder has no account — the mirror of *recipient*.
- **Request link**: the one-time URL a responder opens. The analogue of a
  drop link, direction reversed.
- **Dropzone password**: the password the requester sets at creation, which
  gates collection. Same role as a drop's password, held by the receiver
  instead of the sender.

## Context

Buzzdrop is strictly one-directional today: a sender encrypts, sends and
hands out a drop link; a recipient proves the password and opens the drop
once. There is no way to say "here is a box — drop your secret in it, I
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
   the dropzone appears in their account's list.

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

1. The requester opens the dropzone in their list; each pending submission
   is a row of `{ct, wK}`.
2. Click → password prompt → the browser derives `V` from the attempt; the
   server compares `V` and only then releases `wS` + the ciphertext —
   identical to today's "password first, ciphertext second" gating with
   `attempts`, `KEY_RELEASE_MAX_ATTEMPTS` and lockout.
3. The browser unwraps `s`, unwraps `K`, decrypts, verifies the receipt.
   The submission row is deleted on collection — one-time, mirroring a drop.

### Why not asymmetric crypto

- A private key would live in one browser. Password-derived `wS` works from
  any device — key custody follows the requester's memory, not their
  localStorage.
- Symmetric wrap adds zero new primitives; asymmetric would add ECDH/OpenPGP
  as a second crypto stack to review, ship, and keep in step with the
  protocol contract and the explainer page.

### Threat model notes

- Server compromise yields ciphertexts, wrapped keys, hashes and `wS` — no
  plaintext. `s` never reaches the server; this is the same guarantee BKV3
  already makes for drops.
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
  UI that presents submissions as unverified pending out-of-band
  confirmation.
- The one-time request link is what makes carrying `s` in it acceptable:
  for 1-to-1, "who may submit" ≈ "who may read that one submission".
  **This is the load-bearing assumption.** In multi-responder mode, `s` in
  a shared link would let every responder decrypt everyone's submissions
  given ciphertext access — at that point `s` in the link must be replaced
  by an ephemeral ECDH keypair (WebCrypto, ~30 lines, still no OpenPGP).
  Design the link payload so that piece can be swapped without a redesign.
- Wrong-password lockout is harsher here than in send flow: a typo at the
  last attempt locks a submission the responder can never re-send (their
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
3. **Ala opens her list**, sees a pending submission, clicks, types
   `alamakota123#$`. Her browser derives `V`; the server verifies and
   releases `wS + ct` exactly once. Her browser unwraps `s → K →
   plaintext`. Row deleted; submission collected.

A server-side attacker at any point holds `ct`, `wK`, `wS`, `V`, `SV`
— all useless without `alamakota123#$` and `s`, neither of which ever
touches the server.

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
- i18n: respond page, password prompt, list strings.
- `CONTEXT.md` gains the vocabulary section above.
- Out of scope for v1: multi-responder links, per-submission passwords,
  responder metadata, submission placement questions (they are normal
  blobs — `STORAGE_BACKEND` applies unchanged).
