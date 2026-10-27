"""Exit 0 only if GET /drain on the mail API listener answers 404.
Usage: drainroute.py HOST PORT. A 401 would mean the route exists."""
import sys
import urllib.error
import urllib.request

try:
    urllib.request.urlopen(f"http://{sys.argv[1]}:{sys.argv[2]}/drain", timeout=5)
except urllib.error.HTTPError as error:
    sys.exit(0 if error.code == 404 else 1)
except OSError:
    sys.exit(1)
sys.exit(1)
