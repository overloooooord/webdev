import argparse
import json
import re
import time
import sys
from urllib.parse import urlparse, parse_qs

from .config import BROWSER_HEADERS
from .ms_auth import MicrosoftAuth
from .backup_email import BackupEmailManager
from .imap_helper import IMAPCodeReader
from .ubisoft_exchange import UbisoftExchange
from .xbox_profile import XboxProfile

def run_full_flow(
    email: str,
    password: str,
    backup_email: str = "",
    imap_email: str = "",
    imap_password: str = "",
    imap_host: str = None,
    proxy: str = None,
    skip_backup: bool = False,
) -> dict | None:
    
    print("=" * 60)
    print("  UBISOFT XBOX OAUTH LINKER")
    print("=" * 60)
    print(f"  Account:      {email}")
    print(f"  Backup:       {backup_email or '(none)'}")
    print(f"  Proxy:        {proxy or 'direct'}")
    print("=" * 60)
    print()

    if not imap_email and backup_email:
        imap_email = backup_email

    ms = MicrosoftAuth(proxy=proxy)

    if not ms.start_oauth():
        print("[!] Failed to initialize OAuth")
        return None

    time.sleep(1)

    login_result = ms.login(email, password)
    status = login_result["status"]

    if status == "error":
        print(f"[!] Login error: {login_result.get('message')}")
        return None

    if status == "unknown":
        print(f"[!] Unknown state: {login_result.get('url', '')[:100]}")
        _dump_debug("debug_unknown.html", login_result.get("html", ""))
        return None

    if status == "need_2fa":
        print("[!] 2FA required - not supported in this version")
        return None

    for _attempt in range(3):
        if status == "need_proofs":
            print("\n[*] Microsoft requires security info setup")

            if _attempt > 0:
                skip_backup = True

            if skip_backup:
                backup_mgr = BackupEmailManager(ms.session)
                skip_result = backup_mgr.skip_proofs(
                    login_result["url"], login_result["html"]
                )
                if skip_result.get("status") == "got_code":
                    login_result = {"status": "got_code", "code": skip_result["code"]}
                    status = "got_code"
                    break
                elif skip_result.get("status") == "skipped":
                    print("[*] Skip successful, following redirect...")
                    fm_result = ms._handle_auto_submit_form(skip_result["response"])
                    if fm_result:
                        login_result = fm_result
                        status = fm_result["status"]
                        if status == "got_code":
                            break
                        continue
                    else:
                        print("[!] No redirect form found after skip")
                        break
                else:
                    print("[!] Could not skip security setup")
                    if not backup_email:
                        return None
                    skip_backup = False

            if not skip_backup and backup_email and status == "need_proofs":
                backup_mgr = BackupEmailManager(ms.session)
                add_result = backup_mgr.add_backup_email(
                    backup_email,
                    proofs_url=login_result["url"],
                    proofs_html=login_result["html"],
                )

                if add_result["status"] == "need_verification":
                    if imap_email and imap_password:
                        # Explicitly request code sending (Microsoft does not send it automatically!)
                        print("[*] Requesting OTT verification code from Microsoft...")
                        backup_mgr.request_verification_code(
                            verify_html=add_result.get("html", ""),
                            verify_url=add_result["verify_url"],
                            backup_email=backup_email,
                        )
                        print("[*] Waiting 8s for email delivery...")
                        time.sleep(8)
                        print("[*] Reading verification code via IMAP...")
                        imap = IMAPCodeReader(imap_email, imap_password, imap_host)
                        try:
                            imap.connect()
                            code = imap.get_verification_code(max_wait=120)
                            if not code:
                                print("[!] No code received via IMAP")
                                return None

                            verified = backup_mgr.verify_backup_email(
                                code,
                                canary=add_result.get("canary", ""),
                                verify_url=add_result.get("verify_url"),
                                hidden_fields=add_result.get("hidden_fields"),
                            )
                            if verified.get("status") == "success":
                                print("[+] Backup email verified!\n")
                                print("[*] Continuing OAuth flow...")
                                chain_result = ms.follow_posturl_chain(verified["response"])
                                print(f"[*] Chain result: {chain_result.get('status')}")

                                if chain_result.get("status") in ["got_code", "need_consent", "need_verify_existing"]:
                                    login_result = chain_result
                                    status = login_result["status"]
                                    continue
                                else:
                                    break
                            else:
                                print("[!] Backup email verification failed")
                                return None
                        finally:
                            imap.close()
                    else:
                        print("[!] IMAP credentials not provided")
                        return None
                elif add_result["status"] == "error":
                    print(f"[!] Error: {add_result.get('message')}")
                    return None
            elif not backup_email:
                print("[!] Backup email not provided")
                return None

        elif status == "need_verify_existing":
            print("\n[*] Microsoft requires identity verification")
            if not imap_email or not imap_password:
                print("[!] IMAP credentials required for identity verification")
                return None

            confirm_result = ms.verify_identity_confirm(
                confirm_html=login_result["html"],
                confirm_url=login_result["url"],
                backup_email=backup_email or imap_email,
                imap_email=imap_email,
                imap_password=imap_password,
                imap_host=imap_host,
            )
            login_result = confirm_result
            status = confirm_result["status"]
            print(f"[*] Identity verification result: {status}")
            if status in ("got_code", "need_consent", "error"):
                break
            continue
        else:
            break

    # === CREATING XBOX PROFILE ===
    print("\n[*] Creating Xbox profile if missing...")
    access_token = ms.get_xbox_access_token()
    if access_token:
        xbox = XboxProfile(ms.session)
        x_token_res = xbox.get_xbox_token(access_token)
        if x_token_res:
            xbox.create_profile()
        
        # After getting the access token, we must ensure we are back on track to get the Ubisoft authorization code.
        # If we didn't get the code yet, we can re-request the original Ubisoft authorization url.
        if status != "got_code":
            print("[*] Re-requesting Ubisoft OAuth code...")
            r = ms.session.get(ms.auth_url, headers=BROWSER_HEADERS, allow_redirects=True)
            new_res = ms._resolve_post_login(r)
            status = new_res.get("status", status)
            if "code" in new_res:
                login_result["code"] = new_res["code"]
            elif "canary" in new_res:
                login_result["canary"] = new_res["canary"]
                login_result["url"] = new_res.get("url")
                login_result["html"] = new_res.get("html")




    code = None

    if status == "got_code":
        code = login_result["code"]
    elif status == "need_consent":
        print()
        time.sleep(1)
        code = ms.submit_consent(
            canary=login_result["canary"],
            consent_url=login_result.get("url"),
            consent_html=login_result.get("html"),
        )
    elif status == "unknown":
        print(f"[!] Unknown state: {login_result.get('url', '')[:100]}")
        return None
    elif status == "error":
        print(f"[!] Error: {login_result.get('message', 'unknown')}")
        return None

    if not code:
        print("[!] Failed to obtain authorization code")
        return None

    print(f"\n[+] Authorization code: {code[:50]}...")

    print()
    time.sleep(1)
    ubi = UbisoftExchange(ms.session)
    result = ubi.exchange_code(code)

    if result:
        print()
        print("=" * 60)
        print("  RESULT")
        print("=" * 60)
        print(json.dumps(result, indent=2, ensure_ascii=False))

    return result

def _dump_debug(filename: str, html: str):
    
    if html:
        try:
            with open(filename, "w") as f:
                f.write(html)
            print(f"[*] Debug HTML saved to {filename}")
        except Exception:
            pass

def parse_args():
    parser = argparse.ArgumentParser(
        description="Ubisoft Xbox OAuth Linker",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument("--accounts-file", default="accounts.txt", help="File with email:password per line")
    parser.add_argument("--imap-file", default="imap.txt", help="File with imap_email:password per line")
    parser.add_argument("--proxies-file", default="proxies.txt", help="File with login:pass@host:port per line")
    parser.add_argument("--skip-backup", action="store_true", help="Try to skip backup email setup")
    parser.add_argument("--output", default="results.json", help="Output results file")

    return parser.parse_args()

def main():
    args = parse_args()
    all_results = []

    def read_lines(filename):
        try:
            with open(filename, "r") as f:
                return [line.strip() for line in f if line.strip() and not line.startswith("#")]
        except FileNotFoundError:
            return []

    accounts_raw = read_lines(args.accounts_file)
    imap_raw = read_lines(args.imap_file)
    proxies_raw = read_lines(args.proxies_file)

    if not accounts_raw:
        print(f"Error: No accounts found in {args.accounts_file}")
        sys.exit(1)

    num_accs = len(accounts_raw)
    num_imaps = len(imap_raw)
    num_proxies = len(proxies_raw)

    print(f"Accounts: {num_accs}")
    print(f"IMAP emails: {num_imaps}")
    print(f"Proxies: {num_proxies}")

    if num_imaps > 0:
        print(f"Ratio: ~{round(num_accs / num_imaps, 1)} accounts per 1 IMAP")
    if num_proxies > 0:
        print(f"Ratio: ~{round(num_accs / num_proxies, 1)} accounts per 1 Proxy")

    print()
    ans = input("Start? (y/n): ").strip().lower()
    if ans != 'y':
        print("Aborted.")
        sys.exit(0)

    for i, acct_line in enumerate(accounts_raw, 0):
        if ":" not in acct_line:
            continue
        acct_email, acct_pass = acct_line.split(":", 1)
        
        # Round-robin IMAP
        imap_email, imap_pass = "", ""
        if num_imaps > 0:
            imap_line = imap_raw[i % num_imaps]
            if ":" in imap_line:
                imap_email, imap_pass = imap_line.split(":", 1)
            
        # Round-robin Proxy
        proxy = proxies_raw[i % num_proxies] if num_proxies > 0 else None

        print(f"\n{'#' * 60}")
        print(f"  Account {i+1}/{num_accs}: {acct_email}")
        print(f"{'#' * 60}\n")

        try:
            result = run_full_flow(
                email=acct_email,
                password=acct_pass,
                backup_email=imap_email,
                imap_email=imap_email,
                imap_password=imap_pass,
                proxy=proxy,
                skip_backup=args.skip_backup,
            )

            all_results.append({
                "email": acct_email,
                "success": result is not None,
                "data": result,
            })

        except Exception as e:
            print(f"[!] Exception: {e}")
            import traceback
            traceback.print_exc()
            all_results.append({
                "email": acct_email,
                "success": False,
                "error": str(e),
            })

        if i < num_accs - 1:
            print("\n[*] Waiting 3s before next account...")
            time.sleep(3)

    with open(args.output, "w") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)

    success = sum(1 for r in all_results if r["success"])
    print(f"\n[*] Results saved to: {args.output}")
    print(f"[*] Success: {success}/{len(all_results)}")

if __name__ == "__main__":
    main()
