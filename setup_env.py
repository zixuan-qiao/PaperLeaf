import os
import sys
import urllib.request
import zipfile
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(BASE_DIR, "bin")
TECTONIC_EXE = os.path.join(BIN_DIR, "tectonic.exe")
ZIP_URL = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@0.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip"
ZIP_PATH = os.path.join(BIN_DIR, "tectonic.zip")

def setup_tectonic():
    if os.path.exists(TECTONIC_EXE):
        print(f"[OK] Tectonic already exists at: {TECTONIC_EXE}")
    else:
        print(f"[1/3] Downloading Tectonic from {ZIP_URL}...")
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        req = urllib.request.Request(ZIP_URL, headers=headers)
        
        with urllib.request.urlopen(req) as resp, open(ZIP_PATH, 'wb') as out_file:
            total_size = int(resp.headers.get('Content-Length', 0))
            downloaded = 0
            block_size = 1024 * 256
            
            while True:
                chunk = resp.read(block_size)
                if not chunk:
                    break
                out_file.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    percent = downloaded / total_size * 100
                    print(f"\rDownloading: {downloaded / 1024 / 1024:.1f} MB / {total_size / 1024 / 1024:.1f} MB ({percent:.1f}%)", end="")
            print("\nDownload complete.")

        print("[2/3] Extracting tectonic.exe...")
        with zipfile.ZipFile(ZIP_PATH, 'r') as zip_ref:
            zip_ref.extractall(BIN_DIR)
            
        if os.path.exists(ZIP_PATH):
            os.remove(ZIP_PATH)
        print(f"[OK] Extracted to: {TECTONIC_EXE}")

    print("[3/3] Testing Tectonic execution...")
    res = subprocess.run([TECTONIC_EXE, "--version"], capture_output=True, text=True)
    if res.returncode == 0:
        print("[SUCCESS]", res.stdout.strip())
    else:
        print("[ERROR]", res.stderr.strip())

if __name__ == "__main__":
    setup_tectonic()
