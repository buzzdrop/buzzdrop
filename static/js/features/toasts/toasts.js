// --- Flash toasts (#473) ---
// templates/_flash_toasts.html renders each flashed message as a toast in a
// fixed region over the page, which stays put without JS. Started on every
// page by pages/base, this shows each toast's close button, whose ring is
// the countdown, and closes the toast once its data-toast-timeout has run
// out. The countdown pauses while the pointer is
// on the toast, while focus is in it and while the tab is hidden, and
// resumes from where it stopped. Escape closes the toast focus is in.
import { required, requiredData } from '../../lib/required.js';

/** How long a closing toast fades, as .toast[data-leaving] in tailwind.css. */
export const LEAVE_MS = 200;

/**
 * @typedef {object} ToastsDeps
 * @property {() => number} now - milliseconds, for the time a countdown ran
 */

/** @typedef {'pointer' | 'focus' | 'hidden'} PauseReason */

/**
 * @param {Document} root - any page's document; one with nothing flashed is a no-op
 * @param {ToastsDeps} deps
 */
export function startToasts(root, deps) {
    if (!root.getElementById('toasts')) return;
    const region = required(root, '#toasts', 'section');
    const main = required(root, 'main', 'main');
    const toasts = Array.from(/** @type {NodeListOf<HTMLElement>} */ (region.querySelectorAll('[data-toast]')));
    /** @type {Array<(hidden: boolean) => void>} */
    const onVisibility = [];

    const remaining = () => toasts.filter((toast) => !('leaving' in toast.dataset));

    /**
     * Close a toast: it fades, then leaves the page, and the region with
     * the last one. Focus in it moves on to the next toast's close button,
     * or to the page's content, so it isn't left on a removed element.
     * @param {HTMLElement} toast
     */
    function dismiss(toast) {
        const hadFocus = toast.contains(root.activeElement);
        toast.dataset.leaving = '';
        if (hadFocus) {
            const next = remaining()[0];
            if (next) {
                required(next, '[data-toast-close]', 'button').focus();
            } else {
                main.tabIndex = -1;
                main.focus({ preventScroll: true });
            }
        }
        setTimeout(() => {
            toast.remove();
            if (!region.querySelector('[data-toast]')) region.remove();
        }, LEAVE_MS);
    }

    for (const toast of toasts) {
        const close = required(toast, '[data-toast-close]', 'button');
        const total = Number(requiredData(toast, 'toastTimeout'));

        let left = total;
        let startedAt = 0;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        /** @type {Set<PauseReason>} */
        const pauses = new Set();

        // The ring around the close button runs down by a CSS transition
        // over the time left; paused, it holds the fraction left. Both come
        // to it as custom properties on the button.
        const run = () => {
            startedAt = deps.now();
            timer = setTimeout(() => { timer = undefined; dismiss(toast); }, left);
            close.style.setProperty('--toast-left', `${left}ms`);
            void close.offsetWidth;
            close.dataset.running = '';
        };

        const stop = () => {
            clearTimeout(timer);
            timer = undefined;
            left = Math.max(0, left - (deps.now() - startedAt));
            close.style.setProperty('--toast-fraction', String(left / total));
            delete close.dataset.running;
        };

        /** @param {PauseReason} reason */
        const pause = (reason) => {
            if (!pauses.size && timer !== undefined) stop();
            pauses.add(reason);
        };

        /** @param {PauseReason} reason */
        const resume = (reason) => {
            pauses.delete(reason);
            if (!pauses.size && timer === undefined && !('leaving' in toast.dataset)) run();
        };

        const closeNow = () => {
            clearTimeout(timer);
            dismiss(toast);
        };

        close.hidden = false;

        close.addEventListener('click', closeNow);
        toast.addEventListener('pointerenter', () => pause('pointer'));
        toast.addEventListener('pointerleave', () => resume('pointer'));
        toast.addEventListener('focusin', () => pause('focus'));
        toast.addEventListener('focusout', (event) => {
            const next = /** @type {Node | null} */ (event.relatedTarget);
            if (!next || !toast.contains(next)) resume('focus');
        });
        toast.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeNow();
        });
        onVisibility.push((hidden) => (hidden ? pause('hidden') : resume('hidden')));

        if (root.visibilityState === 'hidden') pauses.add('hidden');
        else run();
    }

    root.addEventListener('visibilitychange', () => {
        const hidden = root.visibilityState === 'hidden';
        onVisibility.forEach((update) => update(hidden));
    });
}
