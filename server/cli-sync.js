// Run a collection from the command line (cron-friendly): npm run sync [-- --full]
import { syncAll } from './collector.js';
const full = process.argv.includes('--full');
const res = await syncAll({ full });
console.log(JSON.stringify(res, null, 2));
process.exit(res.failed ? 1 : 0);
