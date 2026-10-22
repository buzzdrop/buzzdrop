// Page scripts hold no user-facing text (#265, #268): what they write comes
// from the page strings (lib/strings.js), translated by the server. This
// fails on a string literal written straight into text a user meets:
// textContent, an aria attribute, title, placeholder, alt or alert(). It
// sees the literal at the write itself, not one passed through a variable
// or a function first.
//
// Only modules converted to the page strings are checked; each i18n issue
// adds the ones it converts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const JS_ROOT = new URL('../../static/js/', import.meta.url);

const CONVERTED_MODULES = [
    'features/clipboard-feedback/clipboard-feedback.js',
    'features/composer/composer.js',
    'features/password-gate/password-gate.js',
    'features/share-protocol/share-protocol.js',
    'features/shared-files/list.js',
    'features/shared-files/shared-files.js',
    'lib/format.js',
    'lib/passphrase.js',
    'lib/strings.js',
    'pages/collect/collect-page.js',
    'pages/confirm-download/confirm-download-page.js',
    'pages/how-it-works/how-it-works-page.js',
    'pages/index/index-page.js',
    'pages/language-menu/language-menu-page.js',
    'pages/respond/respond-page.js',
    'pages/success/success-page.js',
    'pages/users/users-page.js',
    'pages/view/view-page.js',
];

const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'innerHTML', 'outerHTML', 'title', 'placeholder', 'alt']);
// The aria attributes that hold words; the rest (aria-current, aria-checked…)
// hold tokens.
const TEXT_ATTRIBUTE = /^(aria-(label|valuetext|description|roledescription|placeholder)|title|placeholder|alt)$/;
const TEXT_ARIA_PROPERTY = /^aria(Label|ValueText|Description|RoleDescription|Placeholder)$/;
const LETTER = /\p{L}/u;

/**
 * Whether `node`'s value can be a literal with words in it: a string or
 * template literal, or one of the branches of `?:`, `||`, `&&`, `??` or `+`.
 * A call or a variable is taken as text from elsewhere.
 * @param {any} node
 * @returns {boolean}
 */
function holdsLiteralText(node) {
    switch (node?.type) {
    case 'Literal':
        return typeof node.value === 'string' && LETTER.test(node.value);
    case 'TemplateLiteral':
        return node.quasis.some((/** @type {any} */ quasi) => LETTER.test(quasi.value.cooked ?? ''))
            || node.expressions.some(holdsLiteralText);
    case 'ConditionalExpression':
        return holdsLiteralText(node.consequent) || holdsLiteralText(node.alternate);
    case 'LogicalExpression':
        return holdsLiteralText(node.left) || holdsLiteralText(node.right);
    case 'BinaryExpression':
        return node.operator === '+' && (holdsLiteralText(node.left) || holdsLiteralText(node.right));
    case 'SequenceExpression':
        return holdsLiteralText(node.expressions.at(-1));
    default:
        return false;
    }
}

/** @param {any} node */
function propertyName(node) {
    if (node.type !== 'MemberExpression') return null;
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    return node.property.type === 'Literal' ? String(node.property.value) : null;
}

/**
 * Where `source` writes literal text into what a user meets, as
 * `line N: <sink>` entries.
 * @param {string} source
 * @returns {string[]}
 */
export function literalTextWrites(source) {
    /** @type {string[]} */
    const found = [];
    simple(parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), {
        AssignmentExpression(/** @type {any} */ node) {
            const name = propertyName(node.left);
            if (name && (TEXT_PROPERTIES.has(name) || TEXT_ARIA_PROPERTY.test(name)) && holdsLiteralText(node.right)) {
                found.push(`line ${node.loc.start.line}: ${name}`);
            }
        },
        CallExpression(/** @type {any} */ node) {
            const callee = node.callee.type === 'Identifier' ? node.callee.name : propertyName(node.callee);
            const [first, second] = node.arguments;
            if (callee === 'alert' && holdsLiteralText(first)) {
                found.push(`line ${node.loc.start.line}: alert()`);
            }
            if (callee === 'setAttribute' && first?.type === 'Literal' && TEXT_ATTRIBUTE.test(String(first.value))
                && holdsLiteralText(second)) {
                found.push(`line ${node.loc.start.line}: ${first.value}`);
            }
        },
    });
    return found;
}

for (const module of CONVERTED_MODULES) {
    test(`${module} writes no literal text`, () => {
        assert.deepEqual(literalTextWrites(readFileSync(new URL(module, JS_ROOT), 'utf8')), [],
            `take these words from the page strings (lib/strings.js) in static/js/${module}`);
    });
}

test('the check catches literal text however it is written', () => {
    const cases = {
        "label.textContent = 'Copied!';": ['line 1: textContent'],
        'label.textContent = `${count} copied`;': ['line 1: textContent'],
        "label.textContent = shown ? 'Hide' : 'Show';": ['line 1: textContent'],
        "label.textContent = message || 'Failed';": ['line 1: textContent'],
        "label.textContent = 'Step ' + step;": ['line 1: textContent'],
        "button.title = 'Copy';": ['line 1: title'],
        "field.placeholder = 'Password';": ['line 1: placeholder'],
        "bar.ariaValueText = 'Decrypting…';": ['line 1: ariaValueText'],
        "bar.setAttribute('aria-valuetext', 'Decrypting…');": ['line 1: aria-valuetext'],
        "button.setAttribute('aria-label', 'Close');": ['line 1: aria-label'],
        "button.ariaLabel = 'Close';": ['line 1: ariaLabel'],
        "bar.setAttribute('title', `Opened ${when}`);": ['line 1: title'],
        "deps.alert('Something went wrong');": ['line 1: alert()'],
        "alert('Something went wrong');": ['line 1: alert()'],
        "label['textContent'] = 'Copied!';": ['line 1: textContent'],
    };
    for (const [source, expected] of Object.entries(cases)) {
        assert.deepEqual(literalTextWrites(source), expected, source);
    }
});

test('the check lets through text from elsewhere, and text with no words', () => {
    const allowed = [
        "label.textContent = strings.text('copied');",
        'label.textContent = message;',
        "status.textContent = '';",
        'percent.textContent = `${value}%`;',
        "label.textContent = shown ? strings.text('hide') : strings.text('show');",
        "bar.setAttribute('aria-valuenow', String(value));",
        "bar.setAttribute('data-step', 'decrypting');",
        "step.setAttribute('aria-current', 'step');",
        "item.ariaChecked = 'true';",
        "input.value = 'abc';",
    ];
    for (const source of allowed) {
        assert.deepEqual(literalTextWrites(source), [], source);
    }
});
