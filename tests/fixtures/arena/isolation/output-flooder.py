# Bot fixture attempting to flood stdout with large data
import sys

def main():
    # Flood stdout with 2 MiB of data
    line = "A" * 1000 + "\n"
    for _ in range(2000):
        sys.stdout.write(line)
    sys.stdout.flush()

if __name__ == "__main__":
    main()
