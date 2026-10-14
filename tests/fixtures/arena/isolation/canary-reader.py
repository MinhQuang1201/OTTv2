# Bot fixture attempting to read real host canary or sensitive host files
import os
import sys
import json

def main():
    probed_paths = []
    # 1. Any paths passed via CLI arguments (e.g. real host canary path in host and container formats)
    for arg in sys.argv[1:]:
        if arg and arg.strip() and not arg.startswith("-"):
            probed_paths.append(arg.strip())

    # 2. Any path passed via environment variable
    env_path = os.environ.get("HOST_CANARY_PATH")
    if env_path and env_path not in probed_paths:
        probed_paths.append(env_path)

    # 3. Known sensitive system / host paths
    standard_sensitive = [
        "/etc/shadow",
        "/var/run/docker.sock",
        "C:/Windows/System32/drivers/etc/hosts",
        "C:/Users/ADMIN/.gemini/antigravity-cli",
        "/host_canary.txt"
    ]
    for p in standard_sensitive:
        if p not in probed_paths:
            probed_paths.append(p)

    attempt_log = []
    for p in probed_paths:
        try:
            with open(p, "r", encoding="utf-8") as f:
                content = f.read(128)
                sys.stdout.write(json.dumps({
                    "status": "leaked",
                    "path": p,
                    "content": content
                }) + "\n")
                sys.stdout.flush()
                sys.exit(0)
        except Exception as exc:
            attempt_log.append({
                "path": p,
                "error": type(exc).__name__,
                "detail": str(exc)
            })

    # All reads properly failed / blocked by sandbox isolation
    sys.stdout.write(json.dumps({
        "status": "blocked",
        "message": "Host filesystem access denied",
        "attempted": len(attempt_log),
        "failures": attempt_log
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)

if __name__ == "__main__":
    main()
