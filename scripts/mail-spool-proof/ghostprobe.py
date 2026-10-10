"""What a Ghost-like client sees when the spool is down or hung: one SMTP
attempt, then one Mailgun-shaped HTTP attempt, each under its own timeout.
Prints "<path> raised <ErrorName> after <seconds>s" or "<path> accepted after
<seconds>s", and exits 0 only if both paths raised an error.
Usage: ghostprobe.py DOMAIN API_KEY TIMEOUT_SECONDS"""
import smtplib
import sys
import time
import urllib.request

domain, key, limit = sys.argv[1], sys.argv[2], float(sys.argv[3])
raised = 0


def attempt(path, call):
    global raised
    start = time.monotonic()
    try:
        call()
        print(f"{path} accepted after {time.monotonic() - start:.1f}s")
    except Exception as err:  # the type is the finding
        raised += 1
        print(f"{path} raised {type(err).__name__} after {time.monotonic() - start:.1f}s")


def smtp():
    with smtplib.SMTP("mail-spool", 2525, timeout=limit) as s:
        s.login(domain, key)


def http():
    urllib.request.urlopen("http://mail-spool:8080/healthz", timeout=limit).read()


attempt("smtp", smtp)
attempt("http", http)
sys.exit(0 if raised == 2 else 1)
