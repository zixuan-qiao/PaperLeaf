import os
import sys
import urllib.request
import zipfile
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(BASE_DIR, "bin")
TECTONIC_EXE = os.path.join(BIN_DIR, "tectonic.exe")
ZIP_PATH = os.path.join(BIN_DIR, "tectonic.zip")

DOWNLOAD_URLS = [
    "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@0.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip",
    "https://ghfast.top/https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@0.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip",
    "https://mirror.ghproxy.com/https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@0.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip",
]

def download_file(url, out_path):
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp, open(out_path, 'wb') as out_file:
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

def setup_tectonic():
    os.makedirs(BIN_DIR, exist_ok=True)
    if os.path.exists(TECTONIC_EXE):
        print(f"[OK] Tectonic already exists at: {TECTONIC_EXE}")
    else:
        success = False
        for idx, url in enumerate(DOWNLOAD_URLS, 1):
            print(f"[1/3] Downloading Tectonic (Source {idx}/{len(DOWNLOAD_URLS)}: {url})...")
            try:
                if os.path.exists(ZIP_PATH):
                    os.remove(ZIP_PATH)
                download_file(url, ZIP_PATH)
                if os.path.exists(ZIP_PATH) and os.path.getsize(ZIP_PATH) > 1024 * 1024:
                    success = True
                    break
            except Exception as e:
                print(f"\n[WARN] Failed to download from source {idx}: {e}")
                
        if not success:
            print("\n[ERROR] All automated download sources failed!")
            print("================================================================")
            print("手动安装方法：")
            print("1. 浏览器访问：https://github.com/tectonic-typesetting/tectonic/releases")
            print("2. 下载 tectonic-0.15.0-x86_64-pc-windows-msvc.zip")
            print(f"3. 将压缩包内的 tectonic.exe 解压放置到：{BIN_DIR}")
            print("================================================================")
            sys.exit(1)

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
