"""Exit 0 only if a TCP connection opens. Usage: pyconnect.py HOST PORT"""
import socket
import sys

try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), 3).close()
except OSError:
    sys.exit(1)
