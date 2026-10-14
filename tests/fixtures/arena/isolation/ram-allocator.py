# Bot fixture attempting to exceed memory limit (allocates 400 MiB)
import sys

def main():
    try:
        # Allocate 400 MiB of memory, exceeding 256 MiB container limit
        chunk = bytearray(400 * 1024 * 1024)
        for i in range(0, len(chunk), 4096):
            chunk[i] = 1
        sys.stdout.write("FAIL: Memory allocation succeeded without OOM\n")
        sys.stdout.flush()
    except MemoryError:
        sys.stderr.write("MemoryError trapped\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
