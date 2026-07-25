// CSV Parser — Handles Xbox and PlayStation CSV formats
// Xbox:       Username,Account Level,Login Details,Platform Linked,Platform Login,Backup Email,Date Linked
// PlayStation: Username,Account Level,Login Details,Platform Linked,Platform Login,Platform Email,Platform DOB,Date Linked

/**
 * Parse a CSV string and return structured account objects
 * Handles mixed CSVs (both XBL and PSN in one file)
 */
export function parseCSV(csvContent) {
  const lines = csvContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(line => line.trim().length > 0);

  if (lines.length < 2) {
    return { accounts: [], errors: [] };
  }

  const header = lines[0].trim();
  const headerFields = smartSplit(header);
  const isExtendedFormat = headerFields.length >= 8; // PSN has 8 columns, Xbox has 7

  const accounts = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const fields = smartSplit(line);
      const platformLinked = fields[3]?.trim().toUpperCase();

      if (platformLinked !== 'XBL' && platformLinked !== 'PSN') {
        errors.push({
          line: i + 1,
          raw: line,
          reason: `Invalid platform: "${platformLinked}". Expected XBL or PSN.`
        });
        continue;
      }

      const account = parseAccountLine(fields, platformLinked, i + 1);
      if (account.error) {
        errors.push({
          line: i + 1,
          raw: line,
          reason: account.error
        });
        continue;
      }

      account.raw_line = line;
      account.csv_line = i + 1;
      accounts.push(account);
    } catch (err) {
      errors.push({
        line: i + 1,
        raw: line,
        reason: `Parse error: ${err.message}`
      });
    }
  }

  return { accounts, errors };
}

/**
 * Parse a single account line based on its platform type
 */
function parseAccountLine(fields, platform, lineNumber) {
  try {
    const username = fields[0]?.trim();
    const accountLevel = parseInt(fields[1]?.trim()) || 0;
    const loginDetails = fields[2]?.trim(); // email:password
    const platformLogin = fields[4]?.trim(); // email:password

    if (!username) return { error: 'Missing username' };
    if (!loginDetails) return { error: 'Missing login details' };
    if (!platformLogin) return { error: 'Missing platform login' };

    // Split login details into email:password
    const [loginEmail, ...loginPassParts] = loginDetails.split(':');
    const loginPassword = loginPassParts.join(':'); // Password may contain colons

    const [platformLoginEmail, ...platformPassParts] = platformLogin.split(':');
    const platformLoginPassword = platformPassParts.join(':');

    if (!loginEmail || !loginPassword) return { error: 'Invalid login details format (expected email:password)' };
    if (!platformLoginEmail || !platformLoginPassword) return { error: 'Invalid platform login format (expected email:password)' };

    const account = {
      username,
      account_level: accountLevel,
      login_email: loginEmail,
      login_password: loginPassword,
      platform,
      platform_login_email: platformLoginEmail,
      platform_login_password: platformLoginPassword,
      platform_email: null,
      platform_dob: null,
      backup_email: null,
      date_linked: null,
      login_status: 'pending',
    };

    if (platform === 'PSN') {
      // PSN format: Username,Level,Login,Platform,PlatformLogin,PlatformEmail,PlatformDOB,DateLinked
      const platformEmailField = fields[5]?.trim(); // email:password
      const platformDOB = fields[6]?.trim();
      const dateLinked = fields[7]?.trim();

      if (platformEmailField) {
        // Platform email is in format email:password
        const [pEmail] = platformEmailField.split(':');
        account.platform_email = pEmail;
      }
      account.platform_dob = platformDOB || null;
      account.date_linked = dateLinked || null;
    } else {
      // Xbox format: Username,Level,Login,Platform,PlatformLogin,BackupEmail,DateLinked
      account.backup_email = fields[5]?.trim() || null;
      account.date_linked = fields[6]?.trim() || null;
    }

    return account;
  } catch (err) {
    return { error: `Parse error: ${err.message}` };
  }
}

/**
 * Smart CSV split that handles commas within quoted fields.
 * Follows RFC 4180 — fields containing commas, quotes, or newlines
 * can be enclosed in double quotes. Double-quotes inside quoted fields
 * are escaped as "".
 *
 * Fixes the known issue: passwords containing commas would break the naive split(',').
 */
function smartSplit(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false; // end of quoted field
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current); // push last field
  return fields;
}

/**
 * Validate a manual auth JSON string
 */
export function validateManualAuthJson(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    if (!data.ticket) return { valid: false, error: 'Missing "ticket" field' };
    if (!data.profileId) return { valid: false, error: 'Missing "profileId" field' };
    if (!data.sessionId) return { valid: false, error: 'Missing "sessionId" field' };
    return { valid: true, data };
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${err.message}` };
  }
}
