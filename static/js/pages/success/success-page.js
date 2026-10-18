// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link, the password and the one-click link to clipboard
// - Toggling password visibility
// - Auto-filling the password and one-click link from the URL fragment
// Its words come from the page strings: templates/_success_strings.html, and
// _clipboard_feedback_strings.html for what its copies announce.

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { buildOneClickLink, restoreFragmentAfterLanguageSwitch, stashFragmentForLanguageSwitch, takeFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';
import { readStrings } from '../../lib/strings.js';

/**
 * @typedef {Record<string, never>} SuccessDeps
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the URL and
 * history are read from the root's own window.
 * @returns {SuccessDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the success.html document
 * @param {SuccessDeps} deps
 */
export function initSuccess(root, deps) {
    const window = requiredWindow(root);
    const shareLink = required(root, '#share-link', 'input');
    const oneClickDisplay = required(root, '#one-click-link', 'p');
    const pwdInput = required(root, '#password-display', 'input');
    const copyLinkBtn = required(root, '#copy-link-btn', 'button');
    const copyPasswordBtn = required(root, '#copy-password-btn', 'button');
    const copyOneClickBtn = required(root, '#copy-one-click-btn', 'button');
    const toggleBtn = required(root, '#toggle-password', 'button');
    const toggleLabel = required(toggleBtn, '#toggle-password-label', 'span');
    const pageStrings = readStrings(required(root, '#page-strings-json', 'script'));
    const strings = pageStrings.section('success');
    const clipboardStrings = pageStrings.section('clipboard-feedback');

    // One region for the page announces every copy; the button flash is visual.
    const copyStatus = required(root, '#copy-status', 'p');

    /** The one-click link, once the fragment has supplied a password. */
    let oneClickLink = '';

    /**
     * A reveal's auto-hide; a manual Hide cancels it, so it can't cut a later
     * reveal short.
     * @type {ReturnType<typeof setTimeout> | undefined}
     */
    let hideTimer;

    /**
     * Mask or reveal the password. The toggle keeps one name, "Show
     * password", and says whether it is on with aria-pressed (#326); only
     * its visible label flips between Show and Hide.
     * @param {boolean} visible
     */
    function setVisible(visible) {
        pwdInput.type = visible ? 'text' : 'password';
        toggleLabel.textContent = strings.text(visible ? 'hide' : 'show');
        toggleBtn.setAttribute('aria-pressed', String(visible));
    }

    // Toggle password field between 'password' and 'text' for user convenience
    function togglePasswordVisibility() {
        clearTimeout(hideTimer);
        const visible = pwdInput.type === 'password';
        setVisible(visible);
        if (visible) hideTimer = setTimeout(() => setVisible(false), 5000);
    }

    // Buttons wire up here, not via inline onclick — CSP forbids inline handlers.
    // The share link is copied by selecting its field, which also works over
    // plain HTTP, where there is no Clipboard API; a password field's value
    // can't be copied by selection, and the one-click link isn't on the page
    // in full.
    /** @param {string} subject - what is copied, as clipboard-feedback names it */
    const feedback = (subject) => ({ status: copyStatus, strings: clipboardStrings, subject });
    copyLinkBtn.addEventListener('click', () =>
        copyWithFeedback(copyLinkBtn, shareLink, feedback('link')));
    copyPasswordBtn.addEventListener('click', () =>
        copyWithFeedback(copyPasswordBtn, pwdInput.value, feedback('password')));
    copyOneClickBtn.addEventListener('click', () =>
        copyWithFeedback(copyOneClickBtn, oneClickLink, feedback('oneClickLink')));
    toggleBtn.addEventListener('click', togglePasswordVisibility);

    // Auto-fill the password from the URL fragment (the upload flow navigates
    // here with it). The entry is a module script, so the DOM is already
    // parsed when this runs.
    // A language switch just landed: pick the fragment back up before
    // takeFragmentPassword looks for it.
    restoreFragmentAfterLanguageSwitch(root);
    const fragment = window.location.hash;
    const pwd = takeFragmentPassword(window);
    // If there is one, let it wait out the next language switch in
    // sessionStorage — posting it would leak the password to the server.
    // The fragment was captured before takeFragmentPassword scrubbed it.
    // A page without the language menu has nothing to stash for.
    if (pwd) {
        const langMenu = root.querySelector('#language-menu-list');
        if (langMenu) stashFragmentForLanguageSwitch(langMenu.querySelectorAll('form'), fragment);
    }
    if (pwd) {
        pwdInput.value = pwd;
        toggleBtn.disabled = false;
        copyPasswordBtn.disabled = false;

        // The convenience link: password in the fragment, ready to paste
        // anywhere. Deliberate, and deliberately labelled as such on the page —
        // see the tradeoff spelled out in lib/one-click-link.js. The page shows
        // it with the fragment masked, like the password field.
        oneClickLink = buildOneClickLink(shareLink.value, pwd);
        oneClickDisplay.hidden = false;
        copyOneClickBtn.disabled = false;
    }
}
