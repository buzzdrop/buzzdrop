// The honey progress bar (templates/_progress_bar.html): one element with
// role="progressbar" that shows either a percentage or, busy, the name of a
// step that has none to report. Shown and hidden with the `hidden` attribute.
import { required } from '../../lib/required.js';

/**
 * @typedef {object} ProgressBar
 * @property {(percent: number, step?: string) => void} show - a percentage,
 *   under the step's name when there is one
 * @property {(step: string) => void} busy - a step with no percentage: the
 *   bar runs full width and leaves out aria-valuenow, so it is indeterminate
 * @property {() => void} hide
 */

/**
 * @param {HTMLElement} container - rendered by the progress_bar macro
 * @returns {ProgressBar}
 */
export function createProgressBar(container) {
    const stepLine = required(container, '[data-progress-step]', 'p');
    const fill = required(container, '[data-progress-fill]', 'div');
    const percentLabel = required(container, '[data-progress-percent]', 'span');

    /** @param {string | undefined} step */
    function nameStep(step) {
        stepLine.textContent = step ?? '';
        stepLine.hidden = !step;
    }

    return {
        show(percent, step) {
            delete container.dataset.busy;
            nameStep(step);
            fill.style.width = `${percent}%`;
            percentLabel.textContent = `${percent}%`;
            container.setAttribute('aria-valuenow', String(percent));
            if (step) container.setAttribute('aria-valuetext', `${step} ${percent}%`);
            else container.removeAttribute('aria-valuetext');
            container.hidden = false;
        },
        busy(step) {
            container.dataset.busy = '';
            nameStep(step);
            fill.style.width = '100%';
            percentLabel.textContent = '';
            container.removeAttribute('aria-valuenow');
            container.setAttribute('aria-valuetext', step);
            container.hidden = false;
        },
        hide() {
            container.hidden = true;
        },
    };
}
