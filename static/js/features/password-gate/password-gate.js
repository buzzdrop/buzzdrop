// The composer's password field: the strength meter, Show/Hide, Generate,
// and the gate every upload passes through. The server never sees the
// password (encryption is client-side), so this gate is the only place a
// weak key can be refused — and it must refuse.

import { formatNumber } from '../../lib/format.js';
import { assessPassword, generatePassphrase } from '../../lib/passphrase.js';
import { required } from '../../lib/required.js';

/**
 * @typedef {import('../../lib/strings.js').Strings} Strings
 */

/**
 * @typedef {object} PasswordGate
 * @property {HTMLInputElement} input - the password field
 * @property {(password: string) => boolean} accept - whether `password` may
 *   be used; a missing or weak one is refused inline in #password-error,
 *   with the field focused
 */

// Per level: the bar's and the message's colour, and the key of the word the
// meter reports to assistive tech (the colour carries it on screen).
const WEAK = { fill: 'pw-fill-weak', text: 'pw-text-weak', label: 'weak' };
// Per strength, its level: a common password is drawn weak, and its
// message says why.
/** @type {Record<Exclude<import('../../lib/passphrase.js').Strength, 'empty'>, typeof WEAK>} */
const LEVEL = {
    common: WEAK,
    weak: WEAK,
    fair: { fill: 'pw-fill-fair', text: 'pw-text-fair', label: 'fair' },
    strong: { fill: 'pw-fill-strong', text: 'pw-text-strong', label: 'strong' },
};

/**
 * @typedef {object} PasswordGateOptions
 * @property {Strings} strings - the gate's section of the page strings
 *   (templates/_password_gate_strings.html)
 * @property {string} lang - the page's language, for the numbers in its words
 * @property {(password: string) => void} [onChange] - after every change to
 *   the password, typed or generated, for the page's own controls that act
 *   on it (the index page's Copy)
 */

/**
 * Wire up the password field, or return null where the page has none (an
 * anonymous visitor's landing page).
 * @param {Document} root
 * @param {PasswordGateOptions} options
 * @returns {PasswordGate | null}
 */
export function initPasswordGate(root, options) {
    const input = /** @type {HTMLInputElement | null} */ (root.getElementById('shared-password'));
    return input && wire(root, input, options);
}

/**
 * @param {Document} root
 * @param {HTMLInputElement} input
 * @param {PasswordGateOptions} options
 * @returns {PasswordGate}
 */
function wire(root, input, { strings, lang, onChange }) {
    const levels = strings.section('levels');
    const messages = strings.section('messages');
    const generateBtn = required(root, '#generate-password-btn', 'button');
    const toggleBtn = required(root, '#toggle-password-btn', 'button');
    const strengthRegion = required(root, '#password-strength', 'div');
    const strengthMeter = required(root, '#password-strength-meter', 'div');
    const strengthBar = required(root, '#password-strength-bar', 'div');
    const strengthText = required(root, '#password-strength-text', 'p');
    // Always present: only its text changes, so assistive tech announces
    // every refusal rather than a one-time reveal.
    const refusal = required(root, '#password-error', 'p');

    /**
     * What the meter says about an assessment, in the page's language.
     * @param {import('../../lib/passphrase.js').Assessment} result
     */
    const message = (result) => messages.text(result.strength, { bits: formatNumber(Math.round(result.bits), lang) });

    function updateStrength() {
        const result = assessPassword(input.value);
        if (result.strength === 'empty') {
            strengthRegion.hidden = true;
            return;
        }
        strengthRegion.hidden = false;
        const level = LEVEL[result.strength];
        strengthBar.className = `pw-fill ${level.fill}`;
        // Scale ~90 bits to a full bar so "fair" doesn't read as nearly done.
        // The meter holds the fill once, for the bar's width and for
        // assistive tech alike.
        const fill = Math.min(100, Math.round((result.bits / 90) * 100));
        strengthMeter.style.setProperty('--strength-fill', `${fill}%`);
        strengthMeter.setAttribute('aria-valuenow', String(fill));
        strengthMeter.setAttribute('aria-valuetext', levels.text(level.label));
        strengthText.className = `field-help ${level.text}`;
        strengthText.textContent = message(result);
    }

    /**
     * Mask or reveal the password, keeping the toggle's name in step: it
     * names what pressing it will do.
     * @param {boolean} visible
     */
    function setVisible(visible) {
        input.type = visible ? 'text' : 'password';
        required(toggleBtn, '#toggle-password-label', 'span').textContent = strings.text(visible ? 'hide' : 'show');
        toggleBtn.setAttribute('aria-label', strings.text(visible ? 'hidePassword' : 'showPassword'));
    }

    /** Show/Hide, and whatever the page wires to onChange, have nothing to act on until there is a password. */
    function changed() {
        toggleBtn.disabled = !input.value;
        onChange?.(input.value);
    }

    input.addEventListener('input', () => {
        updateStrength();
        changed();
        // Re-typing clears a stale refusal so the user sees progress.
        refusal.textContent = '';
    });

    toggleBtn.addEventListener('click', () => setVisible(input.type === 'password'));

    generateBtn.addEventListener('click', () => {
        input.value = generatePassphrase();
        // Show the phrase so the sender can read it back on another channel;
        // the success page reveals it again via the URL fragment.
        setVisible(true);
        refusal.textContent = '';
        updateStrength();
        changed();
        input.focus();
    });

    return {
        input,
        accept(password) {
            if (!password) {
                refusal.textContent = strings.text('missing');
                input.focus();
                return false;
            }
            const result = assessPassword(password);
            if (result.blocked) {
                updateStrength();
                refusal.textContent = strings.text('rejected', { reason: message(result) });
                input.focus();
                return false;
            }
            return true;
        },
    };
}
