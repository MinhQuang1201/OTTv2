# Bot fixture spawning background child processes
import subprocess
import sys
import time

def main():
    # Spawn background lingering python process
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    sys.stdout.write(f"Spawned child pid: {p.pid}\n")
    sys.stdout.flush()
    # Parent exits, leaving child orphaned in container cgroup
    sys.exit(0)

if __name__ == "__main__":
    main()
