import { submitViaRealBrowser } from './form-bot.js';
import { getAccountById, initDatabase } from './database.js';

initDatabase();

const accountId = parseInt(process.argv[2], 10);
if (!accountId) {
  console.error(JSON.stringify({ success: false, error: 'Missing account ID' }));
  process.exit(1);
}

const account = getAccountById(accountId);
if (!account) {
  console.error(JSON.stringify({ success: false, error: 'Account not found' }));
  process.exit(1);
}

submitViaRealBrowser(account).then(res => {
  console.log(JSON.stringify(res));
  process.exit(res.success ? 0 : 1);
}).catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
