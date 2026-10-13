"""Stands in for a slot's Ghost: sends one message on each of Ghost's two mail
paths to the spool by name. The subject carries MARKER, so a message can be
recognised in the queue. Usage: ghostmail.py DOMAIN API_KEY smtp|http MARKER"""
import base64
import smtplib
import sys
import urllib.request
import uuid
from email.message import EmailMessage

domain, key, path, marker = sys.argv[1:5]
sender = f"noreply@{domain}"

if path == "smtp":
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, "member@example.com", f"magic link {marker}"
    msg.set_content("PLACEHOLDER_BODY")
    with smtplib.SMTP("mail-spool", 2525, timeout=10) as smtp:
        smtp.login(domain, key)
        smtp.send_message(msg)
else:
    boundary = uuid.uuid4().hex
    fields = {
        "to": "member@example.com",
        "from": sender,
        "subject": f"newsletter {marker}",
        "html": "<p>PLACEHOLDER_BODY</p>",
        "text": "PLACEHOLDER_BODY",
        "recipient-variables": "{}",
    }
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ) + f"--{boundary}--\r\n".encode()
    auth = base64.b64encode(f"api:{key}".encode()).decode()
    req = urllib.request.Request(
        f"http://mail-spool:8080/v3/{domain}/messages",
        data=body,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    urllib.request.urlopen(req, timeout=10).read()
