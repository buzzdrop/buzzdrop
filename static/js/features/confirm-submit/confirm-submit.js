// Destructive forms ask before they submit. A submit listener does it, since
// CSP forbids the inline onclick that once did.
import { requiredWindow } from '../../lib/required.js';

/**
 * Ask `message` when `form` is submitted, in the form's own window, and
 * cancel the submit unless the person accepts.
 * @param {HTMLFormElement} form
 * @param {string} message - translated text
 */
export function confirmBeforeSubmit(form, message) {
    const window = requiredWindow(form.ownerDocument);
    form.addEventListener('submit', (e) => {
        if (!window.confirm(message)) {
            e.preventDefault();
        }
    });
}
