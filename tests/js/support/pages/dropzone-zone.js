// What the respond and collect drivers share: the zones the fixtures were
// rendered for, and a zone put on the protocol fake through its own route, as
// the requester's browser would.
import { DEFAULT_PASSWORD, FIXTURE_CSRF_TOKEN } from './page.js';

/**
 * @typedef {ReturnType<typeof import('../protocol-fake.js').makeProtocolFake>} Fake
 * @typedef {import('../stub-crypto.js').StubDropzoneCrypto} StubDropzoneCrypto
 */

/** The zones render_dom_fixtures.py rendered the pages for. */
export const FIXTURE_ZONES = {
    open: '00000000-0000-4000-8000-0000000000d2',
    locked: '00000000-0000-4000-8000-0000000000d3',
};

/**
 * Create a zone the way the index page does.
 * @param {Fake} backend
 * @param {StubDropzoneCrypto} crypto
 * @param {string} [csrfToken] - the session's token, when it isn't the fixtures'
 */
export async function putZoneOnFake(backend, crypto, csrfToken = FIXTURE_CSRF_TOKEN) {
    const secrets = await crypto.createDropzoneSecrets(DEFAULT_PASSWORD);
    const { salt, ws, v, sv } = secrets;
    const session = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const created = await backend.handle({
        method: 'POST',
        url: '/api/dropzones',
        headers: session,
        body: JSON.stringify({ salt, ws, v, sv }),
    });
    const zoneId = /** @type {string} */ (JSON.parse(String(created.body)).dropzone_id);
    const zone = /** @type {import('../protocol-fake.js').DropzoneRow} */ (backend.state.dropzones.get(zoneId));
    return { zoneId, zone, secrets, session };
}
