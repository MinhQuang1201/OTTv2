# Bot fixture attempting to write to read-only container root
import sys
import json

TARGET_PATHS = ["/pwned.txt", "/usr/bin/pwned", "/etc/pwned"]

def main():
    written = False
    for p in TARGET_PATHS:
        try:
            with open(p, "w", encoding="utf-8") as f:
                f.write("malicious payload")
            written = True
        except OSError as e:
            sys.stderr.write(f"Write blocked: {e}\n")

    if written:
        sys.stdout.write(json.dumps({"error": "ROOT_FS_MUTATED"}) + "\n")
        sys.stdout.flush()
        sys.exit(0)
    else:
        sys.stdout.write(json.dumps({"status": "blocked", "error": "readonly_filesystem"}) + "\n")
        sys.stdout.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
