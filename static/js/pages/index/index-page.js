// --- Index page logic ---
// The composer (file/note tabs, dropzone, upload) and the shared-files list.
// The password gate, the upload protocol, the Copy buttons and the list come
// from their features; this page composes them. The page loads for anonymous
// visitors too, who get neither part, so lookups into those parts keep their
// null checks.

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { initComposer } from '../../features/composer/index.js';
import { confirmBeforeSubmit } from '../../features/confirm-submit/index.js';
import { csrfToken } from '../../features/csrf/index.js';
import { initPasswordGate } from '../../features/password-gate/index.js';
import { createProgressBar } from '../../features/progress-bar/index.js';
import { createShare } from '../../features/share-protocol/index.js';
import { initSharedFilesList } from '../../features/shared-files/index.js';
import { createDropzone } from '../../features/dropzone/index.js';
import * as shareCrypto from '../../lib/crypto.js';
import * as dropzoneCrypto from '../../lib/dropzone-crypto.js';
import { formatNumber, fullTime, parseTimestamp, relativeTime, timeZoneName } from '../../lib/format.js';
import { bytesToHex } from '../../lib/hex.js';
import { buildOneClickLink, takeFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';
import { readStrings } from '../../lib/strings.js';

/**
 * @typedef {import('../../features/share-protocol/index.js').Payload} Payload
 * @typedef {import('../../features/share-protocol/index.js').ShareOptions} ShareOptions
 * @typedef {import('../../features/share-protocol/index.js').CreateResult} CreateResult
 */

/**
 * @typedef {object} IndexDeps
 * @property {typeof fetch} fetch
 * @property {typeof XMLHttpRequest} XMLHttpRequest - supplies upload.onprogress
 * @property {(url: string) => void} navigate
 * @property {import('../../features/share-protocol/index.js').CreateDeps['crypto']} crypto
 * @property {Pick<import('../../lib/dropzone-crypto.js').DropzoneCrypto, 'createDropzoneSecrets'>} dropzoneCrypto
 * @property {() => number} now - epoch milliseconds, for the drop list's relative times
  */

/**
 * The extensions the upload form accepts (`allowed-extensions-json`):
 * lowercase, without the dot.
 * @typedef {string[]} AllowedExtensions
 */

/**
 * The upload endpoints (`upload-endpoints-json`).
 * @typedef {object} UploadEndpoints
 * @property {string} uploadBeginUrl
 * @property {string} uploadUrl
 */

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {IndexDeps}
 */
export function browserDeps() {
    return {
        fetch: window.fetch.bind(window),
        XMLHttpRequest: window.XMLHttpRequest,
        navigate: (url) => { window.location.href = url; },
        crypto: shareCrypto,
        dropzoneCrypto,
        now: () => Date.now(),
    };
}

/**
 * The expiry field's wall-clock time, in the viewer's zone, as the exact
 * moment the server stores (#250); empty when there is none.
 * @param {string} localValue - a `datetime-local` value, e.g. '2099-01-31T12:00'
 * @returns {string}
 */
function expiryInstant(localValue) {
    const moment = new Date(localValue);
    return localValue && !Number.isNaN(moment.getTime()) ? moment.toISOString() : '';
}

/**
 * @param {Document} root - the index.html document
 * @param {IndexDeps} deps
 */
export function initIndex(root, deps) {
    const window = requiredWindow(root);
    let uploadInProgress = false;

    // The index page never uses URL fragments — a stray one here can only be a
    // password leaked by fragment inheritance across a redirect (e.g. a dead
    // one-click link). Taking it scrubs it from the address bar and history.
    takeFragmentPassword(window);

    /**
     * Parse allowed file extensions from a hidden JSON element injected by the server
     * @type {AllowedExtensions}
     */
    const allowedExtensions = JSON.parse(required(root, '#allowed-extensions-json', 'script').text);
    const pageStrings = readStrings(required(root, '#page-strings-json', 'script'));
    const clipboardStrings = pageStrings.section('clipboard-feedback');
    const composerStrings = pageStrings.section('composer');
    const refusals = composerStrings.section('refusals');
    const { lang } = root.documentElement;

    /**
     * Upload endpoints injected the same way — a type="application/json" data
     * island, which CSP does not treat as script.
     * @type {UploadEndpoints}
     */
    const uploadEndpoints = JSON.parse(required(root, '#upload-endpoints-json', 'script').text);

    /**
     * The action button holds an icon alongside its label, so only the label node is rewritten.
     * @param {string} label
     */
    function setShareAction(label) {
        const button = root.getElementById('share-action-btn');
        const labelNode = root.getElementById('share-action-label');
        if (labelNode) {
            labelNode.textContent = label;
        }
        if (button) {
            button.setAttribute('aria-label', label);
        }
    }

    // --- Composer ---
    // The file/note tabs, the drop zone with its file chip and the note
    // panel are a feature (features/composer, markup templates/_composer.html)
    // shared with the dropzone responder's page; this page adds the password
    // gate, the send settings and the upload itself. The mode switch only
    // re-labels the send button here.
    const composer = initComposer(root, {
        strings: composerStrings,
        allowedExtensions,
        onModeChange: (mode) => setShareAction(composerStrings.text(mode === 'file' ? 'sendFile' : 'sendNote')),
    });

    /**
     * Show (or with '', clear) a refusal under the send button, in the
     * always-present #share-error region. The region stays and only its
     * text changes, so assistive tech announces every refusal rather than
     * a one-time reveal. The composer's own refusals live in its regions
     * (features/composer).
     * @param {'share-error'} regionId
     * @param {string} message
     */
    function showRefusal(regionId, message) {
        const region = root.getElementById(regionId);
        if (region) region.textContent = message;
    }

    // --- Password Generation & Strength Gate ---
    // Copy has nothing to copy until there is a password; the template
    // renders it disabled.
    const copyPasswordBtn = /** @type {HTMLButtonElement | null} */ (root.getElementById('copy-password-btn'));
    const passwordGate = initPasswordGate(root, {
        strings: pageStrings.section('password-gate'),
        lang,
        onChange: (password) => { if (copyPasswordBtn) copyPasswordBtn.disabled = !password; },
    });
    if (passwordGate && copyPasswordBtn) {
        const status = required(root, '#password-copy-status', 'p');
        const label = required(copyPasswordBtn, '#copy-password-label', 'span');
        copyPasswordBtn.addEventListener('click', () =>
            copyWithFeedback(copyPasswordBtn, passwordGate.input.value, {
                status, label, strings: clipboardStrings, subject: 'password',
            }));
    }

    /**
     * The password every upload uses, through the gate: null, with the
     * refusal shown, when it is missing or weak.
     * @returns {string | null}
     */
    const acceptedPassword = () => {
        if (!passwordGate) return null;
        const password = passwordGate.input.value;
        return passwordGate.accept(password) ? password : null;
    };

    // --- Expiry ---
    // The field takes a wall-clock time in the viewer's zone, so the hint
    // names that zone the way their language does (#266).
    const expiryZone = root.getElementById('expiry-zone');
    if (expiryZone) {
        const zone = timeZoneName(lang, new Intl.DateTimeFormat().resolvedOptions().timeZone);
        expiryZone.textContent = composerStrings.text('expiryZone', { zone });
        expiryZone.hidden = false;
    }

    // --- Open notifications ---
    // The account email (rendered only when there is one) shows while the
    // box is ticked.
    const notifyCheckbox = /** @type {HTMLInputElement | null} */ (root.getElementById('notify-on-open'));
    const notificationEmailField = root.getElementById('notification-email-field');
    if (notifyCheckbox && notificationEmailField) {
        notifyCheckbox.addEventListener('change', () => {
            notificationEmailField.hidden = !notifyCheckbox.checked;
        });
    }

    // --- Shared Upload Logic ---

    // Read once, reused per request.
    const csrf = csrfToken(root);

    /**
     * The share options as the composer currently holds them.
     * @returns {ShareOptions}
     */
    function readShareOptions() {
        return {
            expiry: expiryInstant(required(root, '#shared-expiry', 'input').value),
            privateNote: required(root, '#shared-private-note', 'textarea').value.trim(),
            notifyOnOpen: required(root, '#notify-on-open', 'input').checked,
            // Rendered only for an account with an email to notify.
            notificationEmail: /** @type {HTMLInputElement | null} */ (
                root.getElementById('notification-email'))?.value.trim() ?? '',
        };
    }

    /**
     * Seal the payload and upload it, with the progress bar standing in for
     * the share button while the upload runs. On success the page leaves for
     * the success page; otherwise it says why under the button, in the words
     * for the refusal's reason, and the button comes back.
     * @param {Payload} payload
     * @param {string} password - carried to the success page in the URL fragment
     */
    async function share(payload, password) {
        const uploadBtn = required(root, '#share-action-btn', 'button');
        const progress = createProgressBar(required(root, '#share-progress', 'div'));

        /** @param {number} percent */
        const showProgress = (percent) => {
            uploadBtn.disabled = true;
            uploadBtn.hidden = true;
            progress.show(percent);
        };

        uploadInProgress = true;
        /** @type {CreateResult} */
        let result;
        try {
            result = await createShare(payload, password, readShareOptions(), {
                fetch: deps.fetch,
                XMLHttpRequest: deps.XMLHttpRequest,
                crypto: deps.crypto,
                urls: { begin: uploadEndpoints.uploadBeginUrl, upload: uploadEndpoints.uploadUrl },
                csrfToken: csrf,
                onProgress: showProgress,
            });
        } catch {
            // Sealing itself failed.
            result = { kind: 'refused', reason: 'send_failed' };
        }

        if (result.kind === 'created') {
            // Hand the password to the success page via the URL fragment —
            // the same in-memory-only channel as one-click links. It is read
            // once there and scrubbed; nothing is persisted.
            deps.navigate(buildOneClickLink(`/success/${result.fileId}`, password));
            return;
        }
        showRefusal('share-error', result.kind === 'refused'
            ? refusals.text(result.reason) : composerStrings.text('unreachable'));
        uploadInProgress = false;
        uploadBtn.disabled = false;
        uploadBtn.hidden = false;
        progress.hide();
    }

    // --- Share action ---
    // The button asks the composer for what to encrypt; a refusal it shows
    // itself, a missing or weak password the gate reports.
    const shareActionButton = root.getElementById('share-action-btn');
    if (shareActionButton && composer) {
        shareActionButton.addEventListener('click', async () => {
            if (uploadInProgress) return;
            // A new attempt: the last one's failure no longer applies.
            showRefusal('share-error', '');
            const payload = composer.getPayload();
            if (!payload) return;
            const password = acceptedPassword();
            if (password === null) return;

            if (payload.kind === 'file') {
                const file = payload.file;
                await share({ kind: 'file', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, password);
            } else {
                await share({ kind: 'text', bytes: new TextEncoder().encode(payload.text) }, password);
            }
        });
    }

    // --- Copy URL to Clipboard Logic ---
    // Every row shares one status region, so a long list does not become a
    // page full of live regions. The per-row pill is visual only.
    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.copy-url')).forEach((button) => {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            // Every .copy-url in the template carries its link in data-url.
            const url = /** @type {string} */ (button.getAttribute('data-url'));
            copyWithFeedback(button, url, {
                status: required(root, '#copy-status', 'p'), strings: clipboardStrings, subject: 'dropLink',
            });
        });
    });

    // Destructive forms carry their confirmation text in data-confirm-message.
    /** @type {NodeListOf<HTMLFormElement>} */ (root.querySelectorAll('form[data-confirm-message]')).forEach((form) => {
        confirmBeforeSubmit(form, () => form.dataset.confirmMessage ?? '');
    });

    // --- Dropzones (ADR-0001) ---
    initDropzones(root, deps, pageStrings.section('dropzones'));

    // --- Shared Files Search & Pagination ---
    initSharedFilesList(root, { fetch: deps.fetch, now: deps.now, strings: pageStrings.section('shared-files') });
}


/**
 * The dropzones section: create (secrets client-side, link shown once),
 * the zone list and delete. Collecting a submission has its own page —
 * the Collect button navigates to /dropzones/<id>/collect.
 * @param {Document} root
 * @param {Pick<IndexDeps, 'fetch' | 'navigate' | 'now' | 'dropzoneCrypto'>} deps
 * @param {import('../../lib/strings.js').Strings} strings
 */
function initDropzones(root, deps, strings) {
    const lang = root.documentElement.lang || 'en';
    const island = required(root, '#dropzones-json', 'script');
    const createBtn = /** @type {HTMLButtonElement | null} */ (root.getElementById('dz-create-btn'));
    if (!createBtn) return;
    const { zones, endpoints } = JSON.parse(island.text);
    const refusals = strings.section('refusals');
    const csrf = () => csrfToken(root);

    const passwordInput = /** @type {HTMLInputElement} */ (root.getElementById('dz-password'));
    const expiryInput = /** @type {HTMLInputElement} */ (root.getElementById('dz-expiry'));
    const memoInput = /** @type {HTMLInputElement} */ (root.getElementById('dz-memo'));
    const notifyInput = /** @type {HTMLInputElement | null} */ (root.getElementById('dz-notify'));
    const errorEl = /** @type {HTMLElement} */ (root.getElementById('dz-error'));
    const linkOut = /** @type {HTMLElement} */ (root.getElementById('dz-link-out'));
    const linkInput = /** @type {HTMLInputElement} */ (root.getElementById('dz-link'));
    const linkStatus = /** @type {HTMLElement} */ (root.getElementById('dz-link-status'));
    const copyBtn = /** @type {HTMLButtonElement} */ (root.getElementById('dz-copy-btn'));
    const listEl = /** @type {HTMLElement} */ (root.getElementById('dz-list'));
    const emptyEl = /** @type {HTMLElement} */ (root.getElementById('dz-empty'));

    /** @param {HTMLElement} el @param {string} code */
    const refuse = (el, code) => {
        try { el.textContent = refusals.text(code); }
        catch { el.textContent = refusals.text('create_failed'); }
    };
    /** @param {Record<string, any>} z */
    const zoneState = (z) => {
        if (z.status === 'expired') return 'expired';
        if (z.collected_at) return 'collected';
        if (z.attempts_remaining === 0) return 'locked';
        if (z.link_consumed_at) return 'ready';
        return 'awaiting';
    };

    /** @param {Array<Record<string, any>>} list */
    function renderZones(list) {
        listEl.replaceChildren();
        emptyEl.hidden = list.length > 0;
        for (const z of list) {
            const li = root.createElement('li');
            li.className = 'flex flex-wrap items-center gap-3 py-3';
            const state = zoneState(z);
            const kind = z.submission_type === 'text' ? strings.text('noteKind') : strings.text('fileKind');
            const meta = root.createElement('div');
            meta.className = 'min-w-0 flex-1';
            const title = root.createElement('p');
            title.className = 'truncate text-sm font-medium text-white';
            title.textContent = z.memo || z.id;
            const sub = root.createElement('p');
            sub.className = 'text-xs text-slate-500';
            sub.textContent = strings.text(state) + (z.submission_type ? ' · ' + kind : '');
            if (state === 'awaiting') {
                const hint = root.createElement('p');
                hint.className = 'mt-0.5 text-xs text-slate-600';
                hint.textContent = strings.text('linkLost');
                meta.append(hint);
            }
            meta.append(title, sub);

            // Same meta grid the drops list renders: when it happened,
            // the deadline, the events, who from.
            const dl = root.createElement('dl');
            dl.className = 'mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400';
            /** @param {string} label @param {string} value @param {string} [title] */
            const metaCell = (label, value, title) => {
                const wrap = root.createElement('div');
                wrap.className = 'flex gap-1.5 break-all';
                const dt = root.createElement('dt');
                dt.className = 'font-semibold uppercase tracking-wider text-slate-500';
                dt.textContent = strings.text(label);
                const dd = root.createElement('dd');
                dd.className = 'tabular-nums';
                dd.textContent = value;
                if (title) dd.title = title;
                wrap.append(dt, dd);
                dl.append(wrap);
            };
            /** @param {string} label @param {string | null | undefined} iso @param {string} fallback */
            const timeCell = (label, iso, fallback) => {
                const then = iso && parseTimestamp(iso);
                metaCell(label,
                    then ? (relativeTime(then, deps.now(), { locale: lang }) ?? fallback) : fallback,
                    then ? (fullTime(then, { locale: lang }) ?? undefined) : undefined);
            };
            timeCell('metaCreated', z.created_at, '—');
            timeCell('metaExpiry', z.expiry_at, strings.text('noExpiry'));
            timeCell('metaSubmitted', z.link_consumed_at, strings.text('notYet'));
            timeCell('metaCollected', z.collected_at, strings.text('notYet'));
            metaCell('metaFrom', z.submitted_by_ip || '—');
            meta.append(dl);
            li.append(meta);
            if (state === 'ready') {
                const btn = root.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-secondary px-4 py-2';
                btn.textContent = strings.text('collect');
                btn.addEventListener('click', () => {
                    deps.navigate(endpoints.actionBase + z.id + '/collect');
                });
                li.append(btn);
            }
            const del = root.createElement('button');
            del.type = 'button';
            del.className = 'btn-danger';
            del.textContent = strings.text('deleteZone');
            del.addEventListener('click', async () => {
                if (!window.confirm(strings.text('confirmDelete'))) return;
                const resp = await deps.fetch(endpoints.actionBase + z.id + '/delete', {
                    method: 'POST', headers: { 'X-CSRF-Token': csrf() },
                });
                if (resp.ok) {
                    // Drop it from the source array too, or the next
                    // renderZones resurrects the row.
                    zones.splice(zones.indexOf(z), 1);
                    renderZones(zones);
                }
            });
            li.append(del);
            listEl.append(li);
        }
    }
    renderZones(zones);

    copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(linkInput.value);
        linkStatus.textContent = strings.text('copied');
    });

    createBtn.addEventListener('click', async () => {
        errorEl.textContent = '';
        const password = passwordInput.value;
        if (!password) { refuse(errorEl, 'noPassword'); return; }
        createBtn.disabled = true;
        try {
            const expiry = expiryInput.value ? new Date(expiryInput.value).toISOString() : null;
            const { dropzoneId, s } = await createDropzone(
                { createUrl: endpoints.createUrl }, deps.fetch, deps.dropzoneCrypto, password,
                { expiry, memo: memoInput.value || null,
                  notifyOnSubmission: Boolean(notifyInput && notifyInput.checked),
                  csrfToken: csrf() });
            linkInput.value = endpoints.respondBase + dropzoneId + '#s=' + bytesToHex(s);
            linkStatus.textContent = strings.text('created');
            linkOut.hidden = false;
            zones.push({ id: dropzoneId, salt: null, status: 'active', memo: memoInput.value || null });
            renderZones(zones);
        } catch (err) {
            refuse(errorEl, /** @type {any} */ (err) && /** @type {any} */ (err).code || 'create_failed');
        } finally {
            createBtn.disabled = false;
        }
    });

}
