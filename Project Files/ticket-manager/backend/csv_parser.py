"""
csv_parser.py - Parse uploaded account CSV files

Supports the exact TZ CSV formats:
  Xbox:  Username,Account Level,Login Details,Platform Linked,Platform Login,Backup Email,Date Linked
  PSN:   Username,Account Level,Login Details,Platform Linked,Platform Login,Platform Email,Platform DOB,Date Linked

Key: "Login Details" and "Platform Login" are in "email:password" format (split on first colon).
     "Platform Email" for PSN is also in "email:password" format.
     "Platform Linked" determines XBL vs PSN regardless of default_platform.
"""
import io
import csv
import logging
from .database import insert_account, insert_failed_account

log = logging.getLogger("csv_parser")


def _split_login(val: str) -> tuple[str, str]:
    """Split 'email:password' into (email, password). Handles passwords with colons."""
    if ":" in val:
        email, password = val.split(":", 1)
        return email.strip(), password.strip()
    return val.strip(), ""


def parse_csv_content(content: str, default_platform: str = "XBL") -> dict:
    """Parse CSV content and add to the database.
    
    Handles both standard column names AND the TZ-specific format:
      - 'Login Details' -> split into login_email + login_password
      - 'Platform Login' -> split into platform_login_email + platform_login_password
      - 'Platform Email' -> split into platform_email (for PSN contact/IMAP)
      - 'Platform Linked' -> XBL or PSN (overrides default_platform)
    """
    lines = content.strip().splitlines()
    if not lines:
        return {"success": 0, "failed": 0, "errors": []}

    # Handle BOM and \r
    lines = [line.strip().rstrip('\r') for line in lines]

    try:
        reader = csv.DictReader(lines)
    except Exception as e:
        return {"success": 0, "failed": 1, "errors": [str(e)]}

    success = 0
    failed = 0
    errors = []

    for i, row in enumerate(reader, start=2):
        raw_data = ",".join(f"{k}:{v}" for k, v in row.items())
        try:
            def get_val(keys):
                for k in keys:
                    if k in row and row[k] and row[k].strip():
                        return row[k].strip()
                return ""

            # -- Username -------------------------------------------------
            username = get_val(["Username", "username", "ID", "id"])
            if not username:
                raise ValueError("Missing username")

            # -- Account Level --------------------------------------------
            level_str = get_val(["Account Level", "account_level", "Level", "level"])
            try:
                account_level = int(level_str) if level_str else 0
            except ValueError:
                account_level = 0

            # -- Login Details (email:password combined) ------------------
            login_details = get_val(["Login Details", "login_details"])
            if login_details:
                login_email, login_password = _split_login(login_details)
            else:
                # Fallback: separate columns
                login_email = get_val(["email", "Email", "login_email", "Login Email", "Mail", "mail"])
                login_password = get_val(["password", "Password", "login_password", "Login Password", "Pass", "pass"])

            if not login_email or not login_password:
                raise ValueError("Missing login email or password (from 'Login Details' or separate columns)")

            # -- Platform Linked ------------------------------------------
            platform_raw = get_val(["Platform Linked", "platform", "Platform"])
            if platform_raw.upper() in ("XBL", "XBOX"):
                platform = "XBL"
            elif platform_raw.upper() in ("PSN", "PLAYSTATION"):
                platform = "PSN"
            else:
                platform = default_platform

            # -- Platform Login (email:password combined) -----------------
            platform_login = get_val(["Platform Login", "platform_login"])
            if platform_login:
                platform_login_email, platform_login_password = _split_login(platform_login)
            else:
                platform_login_email = get_val(["platform_email", "Platform Email", "xbox_email", "psn_email", "Linked Email"])
                platform_login_password = get_val(["platform_password", "Platform Password", "xbox_password", "psn_password", "Linked Password"])

            # -- Platform Email (PSN-specific: email:password for contact/IMAP) -
            platform_email_raw = get_val(["Platform Email", "platform_contact", "Platform Contact"])
            platform_email = ""
            if platform_email_raw:
                # PSN format: "email:password" - extract just the email part for contact
                if ":" in platform_email_raw:
                    platform_email = platform_email_raw  # Keep full value for IMAP use
                else:
                    platform_email = platform_email_raw

            # -- Platform DOB (PSN only) ----------------------------------
            platform_dob = get_val(["Platform DOB", "platform_dob", "dob", "DOB", "date_of_birth"])

            # -- Backup Email ---------------------------------------------
            backup_email = get_val(["Backup Email", "backup_email", "recovery_email", "Recovery Email", "Recovery Mail"])

            # -- Date Linked ----------------------------------------------
            date_linked = get_val(["Date Linked", "date_linked"])

            insert_account({
                "username": username,
                "account_level": account_level,
                "login_email": login_email,
                "login_password": login_password,
                "platform": platform,
                "platform_login_email": platform_login_email,
                "platform_login_password": platform_login_password,
                "platform_email": platform_email,
                "platform_dob": platform_dob,
                "backup_email": backup_email,
                "date_linked": date_linked,
                "login_status": "pending",
            })
            success += 1

        except Exception as e:
            failed += 1
            errors.append(f"Line {i}: {str(e)}")
            insert_failed_account({
                "csv_line": i,
                "raw_data": raw_data,
                "platform": default_platform,
                "failure_reason": str(e),
                "username": row.get("Username", row.get("username", "Unknown")),
            })

    log.info(f"CSV import complete: {success} added, {failed} failed")
    return {"success": success, "failed": failed, "errors": errors}
