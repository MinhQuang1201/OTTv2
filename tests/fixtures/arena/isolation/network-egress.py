# Bot fixture attempting network egress connection
import sys
import json
import urllib.request
import socket

def main():
    connected = False
    # Attempt 1: Raw socket connect
    try:
        s = socket.create_connection(("1.1.1.1", 80), timeout=1)
        s.close()
        connected = True
    except Exception as e:
        sys.stderr.write(f"Socket egress failed: {e}\n")

    # Attempt 2: HTTP urlopen
    if not connected:
        try:
            with urllib.request.urlopen("http://1.1.1.1", timeout=1) as resp:
                connected = True
        except Exception as e:
            sys.stderr.write(f"HTTP egress failed: {e}\n")

    if connected:
        sys.stdout.write(json.dumps({"error": "NETWORK_EGRESS_SUCCEEDED"}) + "\n")
        sys.stdout.flush()
        sys.exit(0)
    else:
        sys.stdout.write(json.dumps({"status": "blocked", "error": "network_disabled"}) + "\n")
        sys.stdout.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
