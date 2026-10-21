# Bot fixture entering an infinite loop
import sys
import time

def main():
    while True:
        time.sleep(0.1)

if __name__ == "__main__":
    main()
