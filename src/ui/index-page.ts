/**
 * Entry module for the landing page.
 *
 * The landing page has no behaviour of its own, but it is the manifest's
 * `start_url` and the page an installed app opens on — so it is the one that
 * most needs to register the service worker. Without this, a user who only
 * ever visits the index never gets an offline copy of anything.
 */

import { registerServiceWorker } from './pwa.js';

registerServiceWorker();
