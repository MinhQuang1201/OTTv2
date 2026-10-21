# Bot fixture attempting PID exhaustion via fork bomb
import os
import sys
import json

def main():
    spawned = 0
    try:
        for i in range(100):
            pid = os.fork()
            if pid == 0:
                # Child process sleeps briefly
                sys.exit(0)
            else:
                spawned += 1
    except OSError as e:
        sys.stderr.write(f"Fork failed at iteration {spawned}: {e}\n")
        sys.stdout.write(json.dumps({"status": "blocked", "error": "pids_limit_enforced", "spawned": spawned}) + "\n")
        sys.stdout.flush()
        sys.exit(1)

    sys.stdout.write(json.dumps({"error": "PIDS_LIMIT_NOT_ENFORCED", "spawned": spawned}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

if __name__ == "__main__":
    main()
