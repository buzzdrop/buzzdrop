import { describe, expect, it } from 'vitest';
import { openLanguageMenuPage, screen } from '../support/pages/language-menu.js';

const button = () => screen.getByRole('button', { name: 'Language: English' });
const item = (/** @type {string} */ name) => screen.getByRole('menuitemradio', { name });

describe('language menu', () => {
    it('starts closed, the button naming the current language', () => {
        openLanguageMenuPage();

        expect(button()).toHaveAttribute('aria-expanded', 'false');
        expect(button()).toHaveAttribute('aria-haspopup', 'menu');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens on a click, listing every language with the current one checked', async () => {
        const menu = openLanguageMenuPage();

        await menu.openMenu();

        expect(button()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('menu', { name: 'Language: English' })).toBeVisible();
        const [first, second, ...rest] = screen.getAllByRole('menuitemradio');
        expect(first).toHaveAccessibleName('English');
        expect(second).toHaveAccessibleName('Polski');
        expect(rest).toEqual([]);
        expect(item('English')).toBeChecked();
        expect(item('Polski')).not.toBeChecked();
        expect(item('Polski')).toHaveAttribute('lang', 'pl');
        expect(item('English')).toHaveFocus();
    });

    it('a second click closes it', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();

        await menu.openMenu();

        expect(screen.queryByRole('menu')).toBeNull();
        expect(button()).toHaveAttribute('aria-expanded', 'false');
    });

    it('picking a language posts it, to come back to this page', async () => {
        const menu = openLanguageMenuPage();

        await menu.pickLanguage('Polski');

        expect(menu.formsSubmitted()).toEqual([{
            action: 'http://localhost/language',
            method: 'post',
            fields: { csrf_token: 'fixture-csrf-token', lang: 'pl', next: '/' },
        }]);
    });

    it('the arrow keys move between the items and wrap; Home and End go to the ends', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();

        await menu.press('ArrowDown');
        expect(item('Polski')).toHaveFocus();
        await menu.press('ArrowDown');
        expect(item('English')).toHaveFocus();
        await menu.press('ArrowUp');
        expect(item('Polski')).toHaveFocus();
        await menu.press('Home');
        expect(item('English')).toHaveFocus();
        await menu.press('End');
        expect(item('Polski')).toHaveFocus();
    });

    it('Enter on an item picks it', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();

        await menu.press('ArrowDown');
        await menu.press('Enter');

        expect(menu.formsSubmitted()).toEqual([expect.objectContaining({ fields: expect.objectContaining({ lang: 'pl' }) })]);
    });

    it('Escape closes it and puts focus back on the button', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();
        await menu.press('ArrowDown');

        await menu.press('Escape');

        expect(screen.queryByRole('menu')).toBeNull();
        expect(button()).toHaveFocus();
        expect(menu.formsSubmitted()).toEqual([]);
    });

    // Enter and Space reach the button as a click in a browser, which
    // happy-dom doesn't do for a <summary>; tests/e2e/language-menu.spec.js
    // presses them in the real browsers.
    it.each([
        ['ArrowDown', 'English'],
        ['ArrowUp', 'Polski'],
    ])('%s on the button opens it with focus on %s', async (key, focused) => {
        const menu = openLanguageMenuPage();

        await menu.openMenuWithKey(key);

        expect(screen.getByRole('menu')).toBeVisible();
        expect(item(focused)).toHaveFocus();
        expect(menu.formsSubmitted()).toEqual([]);
    });

    it('Tab leaves the menu and closes it', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();

        await menu.press('Tab');

        expect(screen.queryByRole('menu')).toBeNull();
        expect(button()).not.toHaveFocus();
    });

    it('a click elsewhere closes it', async () => {
        const menu = openLanguageMenuPage();
        await menu.openMenu();

        await menu.clickElsewhere();

        expect(screen.queryByRole('menu')).toBeNull();
        expect(button()).toHaveAttribute('aria-expanded', 'false');
    });
});
