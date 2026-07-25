import { solveCaptchaBrowser } from './captcha-browser.js';
import { initDatabase } from './database.js';

initDatabase();

solveCaptchaBrowser().then(res => {
  console.log(JSON.stringify(res));
  process.exit(res.success ? 0 : 1);
}).catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
