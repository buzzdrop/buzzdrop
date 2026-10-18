import { initRespond, browserDeps } from './respond-page.js';
import * as dropzoneCrypto from '../../lib/dropzone-crypto.js';

initRespond(document, { ...browserDeps(), crypto: dropzoneCrypto });
