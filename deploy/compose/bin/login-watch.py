#!/usr/bin/env python3
"""login-watch — alert when the authenticated browser session loses its login.

A browser_session container (see browser-session.sh) holds a human login that
meeting bots attach to over CDP. That login expires server-side on the
platform's own timer (e.g. Google Workspace "web session control", ~14 days)
even though the profile cookies stay on disk — after which authenticated bots
silently fail to join until a human re-logs in over noVNC.

This watches for that and fires ONE notification per expiry so a human knows to
go re-login. It reuses the same "are we signed in?" heuristic as the bot's
remote-browser module (modules/remote-browser/src/validate.ts): open a throwaway
tab at the platform account page via the session's in-container CDP HTTP endpoint,
see whether it settles on the account page or gets bounced to a sign-in URL, then
close the tab. Pure docker + curl for the probe — no browser deps on the host.

Commands:
  login-watch.py            Probe; on a logged-in -> logged-out transition, notify once.
  login-watch.py --check    Probe only: print logged_in|logged_out|error, exit 0|1|2. No notify, no state.
  login-watch.py --send-test  Send a test notification through the configured backend and exit.

Which container: BROWSER_SESSION_CONTAINER, else --container, else vexa-browser-session-${USER_ID:-1}.
Which platform:  SESSION_PLATFORM (google|zoom|teams; default google).

Notification backend (first one configured wins):
  NOTIFY_CMD           Run this shell command; subject in $ALERT_SUBJECT, HTML/plain body on stdin.
  NOTIFY_WEBHOOK_URL   HTTP POST {"text": "<subject>\\n\\n<body>"} (Slack/Teams/generic incoming webhook).
  GMAIL_CREDENTIALS_DIR  Gmail API: token.json + client_secret.json in this dir; needs EMAIL_SENDER + ALERT_RECIPIENT.
  SMTP_HOST            smtplib send; needs EMAIL_SENDER + ALERT_RECIPIENT (+ optional SMTP_PORT/USER/PASSWORD/TLS).
  (none)               Log-only: record the event to the log file; no message goes out.

State/log dir: WATCH_STATE_DIR (default ${XDG_STATE_HOME:-~/.local/state}/vexa-login-watch).
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime

# --- probe config per platform (mirrors remote-browser/src/validate.ts) -------
ACCOUNT_URLS = {
    "google": "https://myaccount.google.com/",
    "zoom": "https://zoom.us/profile",
    "teams": "https://teams.microsoft.com/",
}
# If the tab settles on a URL containing any of these, we were bounced to sign-in.
SIGNIN_MARKERS = {
    "google": ["accounts.google.com/signin", "accounts.google.com/v3/signin",
               "ServiceLogin", "/signin/v2"],
    "zoom": ["zoom.us/signin", "/signin", "/login"],
    "teams": ["login.microsoftonline.com", "login.live.com", "/_#/login"],
}
# A settled URL starting with this means we're still signed in.
LOGGEDIN_PREFIX = {
    "google": "https://myaccount.google.com",
    "zoom": "https://zoom.us/profile",
    "teams": "https://teams.microsoft.com",
}

PLATFORM = os.getenv("SESSION_PLATFORM", "google").lower()
CONTAINER = os.getenv("BROWSER_SESSION_CONTAINER") or \
    f"vexa-browser-session-{os.getenv('USER_ID', '1')}"
CDP = os.getenv("BROWSER_SESSION_CDP", "http://127.0.0.1:9222")  # inside the container
NOVNC_HINT = os.getenv("WATCH_NOVNC_URL", "the browser-session noVNC page (browser-session.sh status)")

STATE_DIR = os.getenv(
    "WATCH_STATE_DIR",
    os.path.join(os.getenv("XDG_STATE_HOME", os.path.expanduser("~/.local/state")),
                 "vexa-login-watch"),
)
STATE_FILE = os.path.join(STATE_DIR, f"{CONTAINER}.state")
LOG_FILE = os.path.join(STATE_DIR, "login-watch.log")

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def log(msg: str) -> None:
    line = f"{datetime.now().isoformat(timespec='seconds')} [{CONTAINER}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


# --- probe -------------------------------------------------------------------
def _dexec(args, timeout=30):
    out = subprocess.run(
        ["docker", "exec", CONTAINER] + args,
        capture_output=True, text=True, timeout=timeout,
    )
    if out.returncode != 0:
        raise RuntimeError(f"docker exec {args!r} failed: {out.stderr.strip()[:200]}")
    return out.stdout


def _curl(url, method="GET"):
    args = ["curl", "-s", "--max-time", "20"]
    if method != "GET":
        args += ["-X", method]
    args.append(url)
    return _dexec(args)


def probe_login():
    """Return 'logged_in', 'logged_out', or 'error' (unreachable/ambiguous)."""
    if PLATFORM not in ACCOUNT_URLS:
        log(f"PROBE error: unknown SESSION_PLATFORM={PLATFORM!r}")
        return "error"
    check_url = ACCOUNT_URLS[PLATFORM]
    markers = SIGNIN_MARKERS[PLATFORM]
    prefix = LOGGEDIN_PREFIX[PLATFORM]

    try:
        tab = json.loads(_curl(f"{CDP}/json/new?{check_url}", method="PUT"))
        tab_id = tab["id"]
    except Exception as e:
        log(f"PROBE error: could not open tab: {e}")
        return "error"

    final_url = None
    try:
        for _ in range(12):  # ~18s max for the redirect chain to settle
            time.sleep(1.5)
            try:
                targets = json.loads(_curl(f"{CDP}/json"))
            except Exception:
                continue
            match = next((t for t in targets if t.get("id") == tab_id), None)
            if not match:
                break
            url = match.get("url", "")
            if url and url != "about:blank" and "/RotateCookies" not in url:
                final_url = url
                if url.startswith(prefix) or any(m in url for m in markers):
                    break
    finally:
        try:
            _curl(f"{CDP}/json/close/{tab_id}")
        except Exception as e:
            log(f"PROBE warn: could not close tab {tab_id}: {e}")

    if not final_url:
        log("PROBE error: tab never settled on a URL")
        return "error"
    if any(m in final_url for m in markers):
        log(f"PROBE result: LOGGED OUT (settled at {final_url})")
        return "logged_out"
    if final_url.startswith(prefix):
        log(f"PROBE result: logged in (settled at {final_url})")
        return "logged_in"
    log(f"PROBE ambiguous: settled at {final_url} -> treating as error")
    return "error"


# --- state -------------------------------------------------------------------
def read_state():
    try:
        with open(STATE_FILE) as f:
            return f.read().strip() or "unknown"
    except OSError:
        return "unknown"


def write_state(state):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(STATE_FILE, "w") as f:
            f.write(state + "\n")
    except OSError as e:
        log(f"WARN: could not write state file: {e}")


# --- notification backends ---------------------------------------------------
def _message():
    when = datetime.now().strftime("%B %d, %Y at %I:%M %p")
    subject = f"[vexa] {PLATFORM} session expired on {CONTAINER} — re-login needed"
    body_html = f"""<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
<p>The authenticated <strong>{PLATFORM}</strong> session in <code>{CONTAINER}</code> has
<strong>expired</strong> (detected {when}).</p>
<p>Meeting bots that attach to this session can't join as the signed-in user until someone logs in again.</p>
<p><strong>To fix:</strong> open {NOVNC_HINT} and sign back into {PLATFORM} in the visible browser window.</p>
<p style="color:#888;font-size:12px;">This is a one-time alert; the next one comes only after the next expiry.</p>
</body></html>"""
    body_text = (f"The authenticated {PLATFORM} session in {CONTAINER} has expired "
                 f"(detected {when}). Log back into {PLATFORM} via {NOVNC_HINT}.")
    return subject, body_html, body_text


def _notify_cmd(cmd, subject, body_text):
    env = dict(os.environ, ALERT_SUBJECT=subject)
    subprocess.run(cmd, shell=True, input=body_text, text=True, env=env, check=True)
    log(f"notified via NOTIFY_CMD ({cmd!r})")


def _notify_webhook(url, subject, body_text):
    payload = json.dumps({"text": f"{subject}\n\n{body_text}"})
    subprocess.run(
        ["curl", "-fsS", "--max-time", "20", "-H", "Content-Type: application/json",
         "-X", "POST", "-d", payload, url],
        capture_output=True, text=True, check=True,
    )
    log("notified via NOTIFY_WEBHOOK_URL")


def _notify_gmail(creds_dir, subject, body_html):
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    import base64

    sender = os.environ["EMAIL_SENDER"]
    recipient = os.environ["ALERT_RECIPIENT"]
    token_file = os.path.join(creds_dir, "token.json")
    creds = Credentials.from_authorized_user_file(token_file, GMAIL_SCOPES)
    if not creds.valid and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        try:
            with open(token_file, "w") as f:
                f.write(creds.to_json())
        except OSError:
            pass
    service = build("gmail", "v1", credentials=creds)
    msg = MIMEMultipart("mixed")
    msg["to"], msg["from"], msg["subject"] = recipient, sender, subject
    msg.attach(MIMEText(body_html, "html", "utf-8"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw}).execute()
    log(f"notified via Gmail to {recipient}")


def _notify_smtp(host, subject, body_html):
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    sender = os.environ["EMAIL_SENDER"]
    recipient = os.environ["ALERT_RECIPIENT"]
    msg = MIMEMultipart("mixed")
    msg["Subject"], msg["From"], msg["To"] = subject, sender, recipient
    msg.attach(MIMEText(body_html, "html", "utf-8"))
    port = os.getenv("SMTP_PORT")
    smtp = smtplib.SMTP()
    smtp.connect(host, int(port)) if port else smtp.connect(host)
    if os.getenv("SMTP_TLS", "false").lower() == "true":
        smtp.starttls()
    if os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"):
        smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
    smtp.sendmail(sender, [recipient], msg.as_string())
    smtp.close()
    log(f"notified via SMTP to {recipient}")


def notify():
    subject, body_html, body_text = _message()
    if os.getenv("NOTIFY_CMD"):
        _notify_cmd(os.environ["NOTIFY_CMD"], subject, body_text)
    elif os.getenv("NOTIFY_WEBHOOK_URL"):
        _notify_webhook(os.environ["NOTIFY_WEBHOOK_URL"], subject, body_text)
    elif os.getenv("GMAIL_CREDENTIALS_DIR"):
        _notify_gmail(os.environ["GMAIL_CREDENTIALS_DIR"], subject, body_html)
    elif os.getenv("SMTP_HOST"):
        _notify_smtp(os.environ["SMTP_HOST"], subject, body_html)
    else:
        log(f"NO notification backend configured — logged only. ({subject})")


# --- main --------------------------------------------------------------------
def main():
    if "--send-test" in sys.argv:
        log("Sending a TEST notification (no probe).")
        notify()
        return 0

    result = probe_login()

    if "--check" in sys.argv:
        print(result)
        return {"logged_in": 0, "logged_out": 1}.get(result, 2)

    prev = read_state()
    if result == "error":
        return 0  # container down / ambiguous: leave state, stay quiet
    if result == "logged_in":
        if prev != "logged_in":
            log(f"state {prev} -> logged_in (re-armed)")
        write_state("logged_in")
        return 0
    # logged_out
    if prev == "logged_out":
        log("already logged_out; not re-notifying")
    else:
        log(f"state {prev} -> logged_out; notifying")
        try:
            notify()
        except Exception as e:
            log(f"ERROR sending notification (will retry next run): {e}")
            return 1  # don't record logged_out so the next run retries
    write_state("logged_out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
