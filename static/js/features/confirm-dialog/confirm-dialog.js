// Destructive actions ask first, in the page's own dialog
// (templates/_confirm_dialog.html), not the browser's confirm(): that one's
// buttons are in the browser's language, it can't be styled, and browsers
// let a visitor silence it.
import { required } from '../../lib/required.js';

/**
 * What a confirmation asks, both translated.
 * @typedef {object} Confirmation
 * @property {string} question
 * @property {string} action - the confirm button's label, e.g. "Revoke"
 */

/**
 * Opens the dialog with a question, and resolves true once the person
 * confirms, false once they cancel or press Esc.
 * @typedef {(confirmation: Confirmation) => Promise<boolean>} Ask
 */

/**
 * The page's confirmation dialog, as a function that asks it.
 * @param {Document} root - a page that renders confirm_dialog()
 * @returns {Ask}
 */
export function confirmDialog(root) {
    const dialog = required(root, '#confirm-dialog', 'dialog');
    const question = required(dialog, '.confirm-dialog-question', 'p');
    const action = required(dialog, '.confirm-dialog-action', 'button');
    required(dialog, '.confirm-dialog-cancel', 'button').addEventListener('click', () => dialog.close('cancel'));
    action.addEventListener('click', () => dialog.close('confirm'));

    return (confirmation) => new Promise((resolve) => {
        question.textContent = confirmation.question;
        action.textContent = confirmation.action;
        // Esc closes the dialog without a value.
        dialog.returnValue = '';
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
    });
}

/**
 * Ask before `form` submits, and let the submit through only once the person
 * confirms. A listener does it, since CSP forbids inline handlers.
 * @param {HTMLFormElement} form
 * @param {Ask} ask
 * @param {Confirmation} confirmation
 */
export function confirmBeforeSubmit(form, ask, confirmation) {
    let confirmed = false;
    form.addEventListener('submit', async (e) => {
        if (confirmed) {
            confirmed = false;
            return;
        }
        e.preventDefault();
        const submitter = /** @type {HTMLButtonElement | null} */ (e.submitter);
        if (await ask(confirmation)) {
            confirmed = true;
            form.requestSubmit(submitter);
        }
    });
}
