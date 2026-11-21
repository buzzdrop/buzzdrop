import { within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { LEAVE_MS } from '../../../static/js/pages/toasts/toasts-page.js';
import { openToastsPage, screen } from '../support/pages/toasts.js';

const LOGGED_IN = 'Logged in successfully';
const SUCCESS_MS = 6000;
const ERROR_MS = 10000;

const region = () => screen.queryByRole('region', { name: 'Notifications' });
const shown = (/** @type {string} */ message) => screen.queryByText(message);
const closeButton = () => screen.getByRole('button', { name: 'Close notification' });

describe('flash toasts', () => {
    it('show the flash in a labelled region, with a close button', () => {
        openToastsPage();

        expect(region()).toBeVisible();
        expect(within(/** @type {HTMLElement} */ (region())).getByRole('status')).toHaveTextContent(LOGGED_IN);
        expect(closeButton()).toBeVisible();
    });

    it('an error is an alert', () => {
        openToastsPage({ flashed: [{ kind: 'error', message: 'Drop not found' }] });

        expect(within(/** @type {HTMLElement} */ (region())).getByRole('alert')).toHaveTextContent('Drop not found');
    });

    it('the toasts sit outside the page content', () => {
        openToastsPage();

        expect(within(screen.getByRole('main')).queryByText(LOGGED_IN)).toBeNull();
    });

    it('a success closes on its own after 6 s, and the region with it', () => {
        const toasts = openToastsPage();

        toasts.wait(SUCCESS_MS - 1);
        expect(shown(LOGGED_IN)).toBeVisible();

        toasts.wait(1 + LEAVE_MS);
        expect(shown(LOGGED_IN)).toBeNull();
        expect(region()).toBeNull();
    });

    it('an error stays for 10 s', () => {
        const toasts = openToastsPage({ flashed: [{ kind: 'error', message: 'Drop not found' }] });

        toasts.wait(ERROR_MS - 1);
        expect(shown('Drop not found')).toBeVisible();

        toasts.wait(1 + LEAVE_MS);
        expect(shown('Drop not found')).toBeNull();
    });

    it('the close button closes it at once', async () => {
        const toasts = openToastsPage();

        await toasts.close(LOGGED_IN);
        toasts.wait(LEAVE_MS);

        expect(shown(LOGGED_IN)).toBeNull();
        expect(region()).toBeNull();
    });

    it('the timer bar runs down while the countdown runs', () => {
        const toasts = openToastsPage();

        expect(toasts.timerBar(LOGGED_IN)).toEqual({ left: 1, running: true });
    });

    describe('pausing', () => {
        it('the pointer on the toast holds it, and the bar shows the time left', async () => {
            const toasts = openToastsPage();
            toasts.wait(2000);

            await toasts.pointAt(LOGGED_IN);
            toasts.wait(60_000);

            expect(shown(LOGGED_IN)).toBeVisible();
            expect(toasts.timerBar(LOGGED_IN)).toEqual({ left: 4000 / SUCCESS_MS, running: false });
        });

        it('moving the pointer away resumes from where it stopped, not from the start', async () => {
            const toasts = openToastsPage();
            toasts.wait(2000);
            await toasts.pointAt(LOGGED_IN);
            toasts.wait(10_000);

            await toasts.pointAway(LOGGED_IN);
            expect(toasts.timerBar(LOGGED_IN).running).toBe(true);
            toasts.wait(3999);
            expect(shown(LOGGED_IN)).toBeVisible();

            toasts.wait(1 + LEAVE_MS);
            expect(shown(LOGGED_IN)).toBeNull();
        });

        it('focus on the close button holds it until focus leaves', async () => {
            const toasts = openToastsPage();
            toasts.wait(1000);

            await toasts.tabToClose(LOGGED_IN);
            toasts.wait(60_000);
            expect(shown(LOGGED_IN)).toBeVisible();

            await toasts.press('Tab');
            toasts.wait(SUCCESS_MS - 1000 + LEAVE_MS);
            expect(shown(LOGGED_IN)).toBeNull();
        });

        it('the pointer leaving keeps it held while focus is still in it', async () => {
            const toasts = openToastsPage();
            await toasts.pointAt(LOGGED_IN);
            await toasts.tabToClose(LOGGED_IN);

            await toasts.pointAway(LOGGED_IN);
            toasts.wait(60_000);

            expect(shown(LOGGED_IN)).toBeVisible();
        });

        it('a hidden tab holds it, and coming back resumes it', () => {
            const toasts = openToastsPage();
            toasts.wait(1000);

            toasts.leaveTab();
            toasts.wait(60_000);
            expect(shown(LOGGED_IN)).toBeVisible();

            toasts.returnToTab();
            toasts.wait(SUCCESS_MS - 1000 + LEAVE_MS);
            expect(shown(LOGGED_IN)).toBeNull();
        });

        it('a page opened in a background tab starts counting once it is seen', () => {
            const toasts = openToastsPage({ tabHidden: true });
            toasts.wait(60_000);
            expect(shown(LOGGED_IN)).toBeVisible();

            toasts.returnToTab();
            toasts.wait(SUCCESS_MS + LEAVE_MS);
            expect(shown(LOGGED_IN)).toBeNull();
        });
    });

    describe('from the keyboard', () => {
        it('Escape closes the toast focus is in', async () => {
            const toasts = openToastsPage();
            await toasts.tabToClose(LOGGED_IN);

            await toasts.press('Escape');
            toasts.wait(LEAVE_MS);

            expect(shown(LOGGED_IN)).toBeNull();
        });

        it('closing one moves focus to the next toast\'s close button', async () => {
            const toasts = openToastsPage({
                flashed: [
                    { kind: 'success', message: 'Drop deleted' },
                    { kind: 'error', message: 'Invalid request' },
                ],
            });
            const second = screen.getAllByRole('button', { name: 'Close notification' })[1];
            await toasts.tabToClose('Drop deleted');

            await toasts.press('Enter');

            expect(second).toHaveFocus();
            toasts.wait(LEAVE_MS);
            expect(shown('Drop deleted')).toBeNull();
            expect(shown('Invalid request')).toBeVisible();
        });

        it('closing the last one moves focus to the page content', async () => {
            const toasts = openToastsPage();
            await toasts.tabToClose(LOGGED_IN);

            await toasts.press('Enter');
            toasts.wait(LEAVE_MS);

            expect(screen.getByRole('main')).toHaveFocus();
        });
    });

    it('in Polish, the region and the close button are named in Polish', () => {
        openToastsPage({ language: 'pl' });

        expect(screen.getByRole('region', { name: 'Komunikaty' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Zamknij komunikat' })).toBeVisible();
    });
});
