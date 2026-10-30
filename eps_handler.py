# eps_handler.py - Handle EPS files for PaperLeaf
import os
import sys
import re
import shutil
import subprocess
from PIL import Image

def find_ghostscript():
    local_bin = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bin')
    for name in ['gswin64c.exe', 'gswin32c.exe', 'gs.exe']:
        cand = os.path.join(local_bin, name)
        if os.path.exists(cand):
            return cand
    for name in ['gswin64c', 'gswin32c', 'gs']:
        p = shutil.which(name)
        if p:
            return p
    return None

def convert_eps_to_pdf_png(eps_path):
    base, _ = os.path.splitext(eps_path)
    pdf_path = base + '.pdf'
    png_path = base + '.png'

    eps_mtime = os.path.getmtime(eps_path) if os.path.exists(eps_path) else 0
    if os.path.exists(pdf_path) and os.path.exists(png_path):
        if os.path.getmtime(pdf_path) >= eps_mtime and os.path.getmtime(png_path) >= eps_mtime:
            return True, 'Already up-to-date'

    gs_exe = find_ghostscript()
    if gs_exe:
        try:
            cmd = [
                gs_exe,
                '-sDEVICE=pdfwrite',
                '-dSAFER',
                '-dNOPAUSE',
                '-dBATCH',
                '-dEPSCrop',
                f'-sOutputFile={pdf_path}',
                eps_path
            ]
            creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
            res = subprocess.run(cmd, capture_output=True, timeout=20, creationflags=creation_flags)
            if res.returncode == 0 and os.path.exists(pdf_path):
                try:
                    cmd_png = [
                        gs_exe,
                        '-sDEVICE=png16m',
                        '-r150',
                        '-dSAFER',
                        '-dNOPAUSE',
                        '-dBATCH',
                        '-dEPSCrop',
                        f'-sOutputFile={png_path}',
                        eps_path
                    ]
                    subprocess.run(cmd_png, capture_output=True, timeout=20, creationflags=creation_flags)
                except Exception:
                    pass
                return True, 'Converted via Ghostscript'
        except Exception:
            pass

    try:
        with open(eps_path, 'rb') as f:
            raw_data = f.read()

        if raw_data.startswith(b'\xc5\xd0\xd3\xc6'):
            import struct
            ps_offset, ps_len, wmf_offset, wmf_len, tiff_offset, tiff_len = struct.unpack('<IIIIII', raw_data[4:28])
            if tiff_len > 0:
                import io
                tiff_data = raw_data[tiff_offset:tiff_offset + tiff_len]
                img = Image.open(io.BytesIO(tiff_data))
                img.save(png_path)
                img.convert('RGB').save(pdf_path)
                return True, 'Extracted TIFF preview'
            raw_data = raw_data[ps_offset:ps_offset + ps_len]

        text = raw_data.decode('latin1', errors='ignore')

        bb_match = re.search(r'%%(?:HiRes)?BoundingBox:\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)', text)
        bb_w = None
        if bb_match:
            try:
                x1, y1, x2, y2 = [float(v) for v in bb_match.groups()]
                bb_w = abs(x2 - x1)
            except Exception:
                pass

        wh_match = re.search(r'/Width\s+(\d+)\s+/Height\s+(\d+)', text)
        if wh_match:
            w, h = int(wh_match.group(1)), int(wh_match.group(2))
            dpi = (72.0 * w / bb_w) if (bb_w and bb_w > 0) else 72.0

            pal_match = re.search(r'\[/Indexed\s+/DeviceRGB\s+(\d+)\s+<([^>]+)>', text, re.DOTALL)
            palette = None
            if pal_match:
                pal_hex = re.sub(r'\s+', '', pal_match.group(2))
                palette = bytes.fromhex(pal_hex)

            data_match = re.search(r'(?:image|imagemask)\s+([0-9a-fA-F\s]+)>', text)
            if data_match:
                hex_str = re.sub(r'\s+', '', data_match.group(1))
                pixel_bytes = bytes.fromhex(hex_str)

                if palette:
                    img = Image.frombytes('P', (w, h), pixel_bytes[:w * h])
                    img.putpalette(palette)
                    rgb_img = img.convert('RGB')
                elif len(pixel_bytes) >= w * h * 3:
                    rgb_img = Image.frombytes('RGB', (w, h), pixel_bytes[:w * h * 3])
                elif len(pixel_bytes) >= w * h:
                    rgb_img = Image.frombytes('L', (w, h), pixel_bytes[:w * h]).convert('RGB')
                else:
                    return False, 'Incomplete hex data'

                rgb_img.save(png_path)
                rgb_img.save(pdf_path, resolution=float(dpi))
                return True, f'Converted raster EPS ({w}x{h}) with dpi {dpi:.1f}'

            data_a85 = re.search(r'(?:image|imagemask)\s+([!-\<>-z\s]+)~>', text)
            if data_a85:
                import base64
                a85_str = re.sub(r'\s+', '', data_a85.group(1))
                pixel_bytes = base64.a85decode(a85_str.encode('latin1'))
                if len(pixel_bytes) >= w * h * 3:
                    rgb_img = Image.frombytes('RGB', (w, h), pixel_bytes[:w * h * 3])
                elif len(pixel_bytes) >= w * h:
                    rgb_img = Image.frombytes('L', (w, h), pixel_bytes[:w * h]).convert('RGB')
                else:
                    return False, 'Incomplete ASCII85 data'
                rgb_img.save(png_path)
                rgb_img.save(pdf_path, resolution=float(dpi))
                return True, f'Converted ASCII85 raster EPS ({w}x{h}) with dpi {dpi:.1f}'

    except Exception as e:
        return False, str(e)

    return False, 'Non-raster EPS without Ghostscript'

def preprocess_project_eps(project_dir):
    if not os.path.isdir(project_dir):
        return

    has_eps = False
    converted_files = set()
    for root, dirs, files in os.walk(project_dir):
        if os.path.basename(root) in ('build', '.history') or '.history' in root:
            continue
        for file in files:
            if file.lower().endswith('.eps'):
                has_eps = True
                eps_path = os.path.join(root, file)
                success, _ = convert_eps_to_pdf_png(eps_path)
                if success:
                    base_name = os.path.splitext(file)[0]
                    converted_files.add(base_name.lower())

    if not has_eps:
        return

    for root, dirs, files in os.walk(project_dir):
        if os.path.basename(root) in ('build', '.history') or '.history' in root:
            continue
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in ['.tex', '.cls', '.sty']:
                full_path = os.path.join(root, file)
                try:
                    encoding = 'utf-8'
                    try:
                        with open(full_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                    except UnicodeDecodeError:
                        encoding = 'latin1'
                        with open(full_path, 'r', encoding='latin1') as f:
                            content = f.read()

                    changed = False

                    if '\\logoname.eps' in content:
                        content = content.replace('\\logoname.eps', '\\logoname.pdf')
                        changed = True

                    def replace_eps_include(m):
                        prefix = m.group(1)
                        img_path = m.group(2)
                        suffix = m.group(3)
                        return f'{prefix}{img_path}.pdf{suffix}'

                    new_content = re.sub(
                        r'(\\includegraphics(?:\[[^\]]*\])?\{)([^}\n\r]+?)\.eps(\})',
                        replace_eps_include,
                        content,
                        flags=re.IGNORECASE
                    )
                    if new_content != content:
                        content = new_content
                        changed = True

                    if changed:
                        with open(full_path, 'w', encoding=encoding) as f:
                            f.write(content)
                except Exception as e:
                    print(f'[WARN] Error updating EPS reference in {full_path}: {e}')
