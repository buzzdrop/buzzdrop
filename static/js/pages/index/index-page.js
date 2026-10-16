// --- Index page logic ---
// The composer (file/note tabs, dropzone, upload) and the shared-files list.
// The password gate, the upload protocol, the Copy buttons and the list come
// from their features; this page composes them. The page loads for anonymous
// visitors too, who get neither part, so lookups into those parts keep their
// null checks.

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { csrfToken } from '../../features/csrf/index.js';
import { initPasswordGate } from '../../features/password-gate/index.js';
import { createProgressBar } from '../../features/progress-bar/index.js';
import { createShare } from '../../features/share-protocol/index.js';
import { initSharedFilesList } from '../../features/shared-files/index.js';
import { createDropzone, collectDropzone } from '../../features/dropzone/index.js';
import { isAllowedFile } from '../../lib/file-extensions.js';
import * as shareCrypto from '../../lib/crypto.js';
import { timeZoneName } from '../../lib/format.js';
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
    /** @type {'file' | 'text'} */
    let activeShareMode = 'file';
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

    // --- Tab Switching Logic ---
    // The composer's two modes are an ARIA tab set: the rail is the tablist and
    // each section is the panel its tab controls.
    const shareModes = {
        file: { tab: 'file-tab', panel: 'file-upload-section', action: 'sendFile' },
        text: { tab: 'text-tab', panel: 'text-note-section', action: 'sendNote' },
    };
    /** @type {Array<'file' | 'text'>} */
    const shareModeOrder = ['file', 'text'];

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

    /**
     * Toggling one class rather than reassigning className, so the ARIA state set
     * below survives a mode switch.
     * @param {'file' | 'text'} mode
     * @param {{focusTab?: boolean}} [options]
     */
    function selectShareMode(mode, { focusTab = false } = {}) {
        activeShareMode = mode;

        shareModeOrder.forEach((name) => {
            const { tab, panel } = shareModes[name];
            const isActive = name === mode;
            const tabNode = root.getElementById(tab);
            const panelNode = root.getElementById(panel);

            // visibility, not display: the panels share a grid cell sized to
            // the taller one (index.html), so the inactive one keeps its space.
            if (panelNode) panelNode.style.visibility = isActive ? '' : 'hidden';
            if (!tabNode) return;

            tabNode.classList.toggle('share-tab-active', isActive);
            tabNode.setAttribute('aria-selected', String(isActive));
            // Roving tabindex: Tab reaches the rail once, arrows move within it.
            tabNode.tabIndex = isActive ? 0 : -1;
            if (isActive && focusTab) tabNode.focus();
        });

        setShareAction(composerStrings.text(shareModes[mode].action));
    }

    function showFileUpload() {
        selectShareMode('file');
    }

    function showTextNote() {
        selectShareMode('text');
    }

    // Tabs wire up here, not via inline onclick — CSP forbids inline handlers.
    root.getElementById('file-tab')?.addEventListener('click', showFileUpload);
    root.getElementById('text-tab')?.addEventListener('click', showTextNote);

    // The tab role promises a keyboard contract, so honour it: arrows move between
    // tabs, Home and End jump to the ends.
    const shareTabRail = /** @type {HTMLElement | null} */ (root.querySelector('.tab-rail'));
    if (shareTabRail) {
        shareTabRail.addEventListener('keydown', (e) => {
            const current = shareModeOrder.indexOf(activeShareMode);
            const last = shareModeOrder.length - 1;
            let next;

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                next = current === last ? 0 : current + 1;
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                next = current === 0 ? last : current - 1;
            } else if (e.key === 'Home') {
                next = 0;
            } else if (e.key === 'End') {
                next = last;
            } else {
                return;
            }

            e.preventDefault();
            selectShareMode(shareModeOrder[next], { focusTab: true });
        });
    }

    /**
     * Show (or with '', clear) a refusal in one of the always-present error
     * regions (#file-error, #note-error, #share-error). The region stays and
     * only its text changes, so assistive tech announces every refusal rather
     * than a one-time reveal.
     * @param {'file-error' | 'note-error' | 'share-error'} regionId
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

    // --- Dropzone Logic ---
    /**
     * Show (or clear) the chip naming the file that is queued for encryption.
     * @param {File | null} file
     */
    function showSelectedFile(file) {
        const chip = root.getElementById('file-selected');
        const chipName = root.getElementById('file-selected-name');
        if (!chip || !chipName) return;
        chipName.textContent = file ? file.name : '';
        chip.hidden = !file;
    }

    /**
     * Reject a disallowed file, discarding any earlier selection along with it.
     * @param {HTMLInputElement} input
     */
    function rejectFile(input) {
        input.value = '';
        showSelectedFile(null);
        showRefusal('file-error', refusals.text('type_not_allowed'));
    }

    const dropzone = root.getElementById('file-dropzone');
    if (dropzone) {
        const fileField = required(root, '#file', 'input');

        /** @param {boolean} isDragging */
        const setDragging = (isDragging) => dropzone.classList.toggle('dropzone-active', isDragging);

        ['dragenter', 'dragover'].forEach((eventName) => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                setDragging(true);
            });
        });

        // dragleave also fires when crossing into a child, so ignore those.
        dropzone.addEventListener('dragleave', (e) => {
            if (!dropzone.contains(/** @type {Node | null} */ (e.relatedTarget))) {
                setDragging(false);
            }
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer && e.dataTransfer.files[0];
            if (!file) return;
            if (!isAllowedFile(file.name, allowedExtensions)) {
                rejectFile(fileField);
                return;
            }
            // Hand the dropped file to the real input so the form submits it unchanged.
            const transfer = new window.DataTransfer();
            transfer.items.add(file);
            fileField.files = transfer.files;
            showSelectedFile(file);
            showRefusal('file-error', '');
        });
    }

    // --- File Upload Logic ---
    const fileUploadForm = /** @type {HTMLFormElement | null} */ (root.querySelector('#file-upload-section form'));
    if (fileUploadForm) {
        // Validate file extension when a file is selected
        required(root, '#file', 'input').addEventListener('change', (e) => {
            const input = /** @type {HTMLInputElement} */ (e.target);
            const file = input.files?.[0];
            if (!file) {
                showSelectedFile(null);
                return;
            }
            if (!isAllowedFile(file.name, allowedExtensions)) {
                rejectFile(input);
                return;
            }
            showSelectedFile(file);
            showRefusal('file-error', '');
        });

        // Handle form submission: encrypt file client-side, then upload
        fileUploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (uploadInProgress) return;
            const file = required(root, '#file', 'input').files?.[0];
            if (!file) {
                showRefusal('file-error', composerStrings.text('chooseFile'));
                return;
            }
            const password = acceptedPassword();
            if (password === null) return;

            await share({ kind: 'file', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, password);
        });
    }

    // --- Text Note Upload Logic ---
    const noteInput = root.getElementById('note-text');
    if (noteInput) {
        noteInput.addEventListener('input', () => showRefusal('note-error', ''));
    }

    async function uploadNote() {
        if (uploadInProgress) return;
        const noteField = required(root, '#note-text', 'textarea');
        const noteText = noteField.value;
        if (!noteText) {
            showRefusal('note-error', composerStrings.text('writeNote'));
            noteField.focus();
            return;
        }
        const password = acceptedPassword();
        if (password === null) return;

        await share({ kind: 'text', bytes: new TextEncoder().encode(noteText) }, password);
    }

    const shareActionButton = root.getElementById('share-action-btn');
    if (shareActionButton) {
        shareActionButton.addEventListener('click', () => {
            if (uploadInProgress) return;
            // A new attempt: the last one's failure no longer applies.
            showRefusal('share-error', '');
            if (activeShareMode === 'text') {
                uploadNote();
                return;
            }

            const fileForm = /** @type {HTMLFormElement | null} */ (root.querySelector('#file-upload-section form'));
            if (fileForm) {
                fileForm.requestSubmit();
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

    // Destructive forms carry their confirmation text in data-confirm-message —
    // a submit listener replaces the old inline onclick, which CSP forbids.
    /** @type {NodeListOf<HTMLFormElement>} */ (root.querySelectorAll('form[data-confirm-message]')).forEach((form) => {
        form.addEventListener('submit', (e) => {
            if (!window.confirm(form.dataset.confirmMessage)) {
                e.preventDefault();
            }
        });
    });

    // --- Dropzones (ADR-0001) ---
    initDropzones(root, deps, pageStrings.section('dropzones'));

    // --- Shared Files Search & Pagination ---
    initSharedFilesList(root, { fetch: deps.fetch, now: deps.now, strings: pageStrings.section('shared-files') });
}


/**
 * The dropzones section: create (secrets client-side, link shown once),
 * the zone list, collect (V → release → fetch → unwrap → save → report)
 * and delete.
 * @param {Document} root
 * @param {{ fetch: typeof fetch }} deps
 * @param {import('../../lib/strings.js').Strings} strings
 */
function initDropzones(root, deps, strings) {
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
    const collectForm = /** @type {HTMLFormElement} */ (root.getElementById('dz-collect-form'));
    const collectPassword = /** @type {HTMLInputElement} */ (root.getElementById('dz-collect-password'));
    const collectError = /** @type {HTMLElement} */ (root.getElementById('dz-collect-error'));

    /** @param {string} id */
    const zoneEndpoints = (id) => ({
        zoneUrl: endpoints.zoneBase + id,
        releaseUrl: endpoints.actionBase + id + '/release',
        submissionUrl: endpoints.actionBase + id + '/submission',
        reportUrl: endpoints.actionBase + id + '/report',
    });
    /** @param {HTMLElement} el @param {string} code */
    const refuse = (el, code) => {
        try { el.textContent = refusals.text(code); }
        catch { el.textContent = refusals.text('create_failed'); }
    };
    /** @param {Record<string, any>} z */
    const zoneState = (z) => {
        if (z.status === 'expired') return 'expired';
        if (z.collected_at) return 'collected';
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
            meta.append(title, sub);
            li.append(meta);
            if (state === 'ready') {
                const btn = root.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-secondary px-3 py-1.5 text-xs';
                btn.textContent = strings.text('collect');
                btn.addEventListener('click', () => {
                    collectForm.dataset.zone = z.id;
                    collectForm.classList.remove('hidden');
                    collectPassword.value = '';
                    collectPassword.focus();
                });
                li.append(btn);
            }
            const del = root.createElement('button');
            del.type = 'button';
            del.className = 'btn-secondary px-3 py-1.5 text-xs';
            del.textContent = strings.text('deleteZone');
            del.addEventListener('click', async () => {
                const resp = await deps.fetch(endpoints.actionBase + z.id + '/delete', {
                    method: 'POST', headers: { 'X-CSRF-Token': csrf() },
                });
                if (resp.ok) li.remove();
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
                { createUrl: endpoints.createUrl }, deps.fetch, password,
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

    collectForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        collectError.textContent = '';
        const id = collectForm.dataset.zone || '';
        const zone = zones.find((/** @type {Record<string, any>} */ z) => z.id === id);
        if (!zone) return;
        try {
            const opened = await collectDropzone(
                zoneEndpoints(id), deps.fetch, zone, collectPassword.value, csrf());
            const blob = new Blob([opened.data]);
            const a = root.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = opened.name || 'submission';
            a.click();
            URL.revokeObjectURL(a.href);
            zone.collected_at = new Date().toISOString();
            renderZones(zones);
            collectForm.classList.add('hidden');
        } catch (err) {
            const e = /** @type {any} */ (err);
            if (e && typeof e.attemptsRemaining === 'number') {
                collectError.textContent = strings.plural('attemptsRemaining', e.attemptsRemaining);
            } else {
                refuse(collectError, (e && e.code) || 'release_failed');
            }
        }
    });
}
