import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Every test file gets its own throw-away database before any server module loads.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'cp-test-')), 'test.db');
process.env.APP_SECRET = 'test-secret';
process.env.SYNC_INTERVAL_MINUTES = '0';
process.env.LOG_LEVEL = 'silent';
