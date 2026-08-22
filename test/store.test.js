/**
 * The in-memory store must satisfy the shared contract in storeContract.js.
 *
 * When the Mongo store lands, `test/mongoStore.test.js` runs this identical suite against
 * a real database, skipping itself if MONGO_URI is unset so a clean clone still passes.
 */

import { createMemoryStore } from '../src/db/store.js';
import { runStoreContract } from './storeContract.js';

runStoreContract('memory', async () => createMemoryStore());
