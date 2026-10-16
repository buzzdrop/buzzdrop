// The file-or-note composer (markup: templates/_composer.html): the
// File/Note tab rail, the drop zone with its file chip, and the note
// panel. The index page composes it with the password gate, the send
// settings and the share upload; the dropzone responder's page composes
// it with its submit button. Every refusal lands in the composer's own
// always-present error regions (#file-error, #note-error); what passes is
// handed back through getPayload() for the page to encrypt.

import { isAllowedFile } from '../../lib/file-extensions.js';
import { required, requiredWindow } from '../../lib/required.js';

/**
 * @typedef {import('../../lib/strings.js').Strings} Strings
 */

/**
 * What getPayload() hands the page to encrypt: the chosen file itself, or
 * the note's text. `null` means the composer already refused inline.
 * @typedef {{ kind: 'file', file: File } | { kind: 'text', text: string }} ComposerPayload
 */

/**
 * @typedef {object} ComposerOptions
 * @property {Strings} strings - the composer's section of the page strings:
 *   `chooseFile`, `writeNote` and a `refusals` section with
 *   `type_not_allowed` — plus `file_too_large` and `note_too_large`, which
 *   are read only when `maxBytes` is given
 * @property {string[]} allowedExtensions - lowercase, without the dot
 * @property {number} [maxBytes] - the server's size cap in bytes; without
 *   it there is no client-side size check and the server refuses instead
 * @property {(mode: 'file' | 'text') => void} [onModeChange] - after every
 *   tab switch (the index page re-labels its send button from the mode)
 */

/**
 * @typedef {object} Composer
 * @property {() => ComposerPayload | null} getPayload - what to encrypt,
 *   or null after the composer showed the refusal itself
 * @property {() => void} reset - scrub the file, its chip, the note and
 *   the refusals (the respond page calls it once a submission lands)
 */

/**
 * Wire up the composer, or return null where the page has none (the index
 * page's anonymous landing).
 * @param {Document} root
 * @param {ComposerOptions} options
 * @returns {Composer | null}
 */
export function initComposer(root, options) {
    const dropzone = root.getElementById('file-dropzone');
    return dropzone && wire(root, dropzone, options);
}

/**
 * @param {Document} root
 * @param {HTMLElement} dropzone - the drop zone's <label>
 * @param {ComposerOptions} options
 * @returns {Composer}
 */
function wire(root, dropzone, { strings, allowedExtensions, maxBytes, onModeChange }) {
    const window = requiredWindow(root);
    const refusals = strings.section('refusals');
    const rail = required(root, '.tab-rail', 'div');
    const tabs = {
        file: required(root, '#file-tab', 'button'),
        text: required(root, '#text-tab', 'button'),
    };
    const panels = {
        file: required(root, '#file-upload-section', 'div'),
        text: required(root, '#text-note-section', 'div'),
    };
    const fileField = required(root, '#file', 'input');
    const chip = required(root, '#file-selected', 'p');
    const chipName = required(root, '#file-selected-name', 'span');
    const fileError = required(root, '#file-error', 'p');
    const noteField = required(root, '#note-text', 'textarea');
    const noteError = required(root, '#note-error', 'p');

    // --- Tab switching ---
    // The two modes are an ARIA tab set: the rail is the tablist and each
    // section is the panel its tab controls.
    /** @type {'file' | 'text'} */
    let activeMode = 'file';
    /** @type {Array<'file' | 'text'>} */
    const modeOrder = ['file', 'text'];

    /**
     * @param {'file' | 'text'} mode
     * @param {{ focusTab?: boolean }} [options]
     */
    function selectMode(mode, { focusTab = false } = {}) {
        activeMode = mode;
        for (const name of modeOrder) {
            const isActive = name === mode;
            // visibility, not display: the panels share a grid cell sized
            // to the taller one (_composer.html), so the inactive one
            // keeps its space.
            panels[name].style.visibility = isActive ? '' : 'hidden';
            // One class toggled rather than reassigning className, so the
            // ARIA state set here survives a mode switch.
            tabs[name].classList.toggle('share-tab-active', isActive);
            tabs[name].setAttribute('aria-selected', String(isActive));
            // Roving tabindex: Tab reaches the rail once, arrows move within it.
            tabs[name].tabIndex = isActive ? 0 : -1;
            if (isActive && focusTab) tabs[name].focus();
        }
        onModeChange?.(mode);
    }

    // Tabs wire up here, not via inline onclick — CSP forbids inline handlers.
    tabs.file.addEventListener('click', () => selectMode('file'));
    tabs.text.addEventListener('click', () => selectMode('text'));

    // The tab role promises a keyboard contract, so honour it: arrows move
    // between tabs, Home and End jump to the ends.
    rail.addEventListener('keydown', (e) => {
        const current = modeOrder.indexOf(activeMode);
        const last = modeOrder.length - 1;
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
        selectMode(modeOrder[next], { focusTab: true });
    });

    // --- The drop zone and the file chip ---
    /**
     * Show (or clear) the chip naming the file that is queued for encryption.
     * @param {File | null} file
     */
    function showSelectedFile(file) {
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
        fileError.textContent = refusals.text('type_not_allowed');
    }

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
        // Hand the dropped file to the real input so getPayload reads it unchanged.
        const transfer = new window.DataTransfer();
        transfer.items.add(file);
        fileField.files = transfer.files;
        showSelectedFile(file);
        fileError.textContent = '';
    });

    fileField.addEventListener('change', () => {
        const file = fileField.files?.[0];
        if (!file) {
            showSelectedFile(null);
            return;
        }
        if (!isAllowedFile(file.name, allowedExtensions)) {
            rejectFile(fileField);
            return;
        }
        showSelectedFile(file);
        fileError.textContent = '';
    });

    // The form would post the plaintext file to /upload; everything goes
    // through getPayload() and client-side encryption instead.
    required(root, '#file-upload-section form', 'form').addEventListener('submit', (e) => {
        e.preventDefault();
    });

    // Re-typing clears a stale refusal so the user sees progress.
    noteField.addEventListener('input', () => { noteError.textContent = ''; });

    return {
        getPayload() {
            if (activeMode === 'text') {
                const text = noteField.value;
                if (!text) {
                    noteError.textContent = strings.text('writeNote');
                    noteField.focus();
                    return null;
                }
                if (maxBytes !== undefined && new TextEncoder().encode(text).length > maxBytes) {
                    noteError.textContent = refusals.text('note_too_large');
                    return null;
                }
                return { kind: 'text', text };
            }
            const file = fileField.files?.[0];
            if (!file) {
                fileError.textContent = strings.text('chooseFile');
                return null;
            }
            if (!isAllowedFile(file.name, allowedExtensions)) {
                rejectFile(fileField);
                return null;
            }
            if (maxBytes !== undefined && file.size > maxBytes) {
                fileError.textContent = refusals.text('file_too_large');
                return null;
            }
            return { kind: 'file', file };
        },
        reset() {
            fileField.value = '';
            noteField.value = '';
            showSelectedFile(null);
            fileError.textContent = '';
            noteError.textContent = '';
        },
    };
}
