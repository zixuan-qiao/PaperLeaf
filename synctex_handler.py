# synctex_handler.py - Fast pure-Python Bidirectional SyncTeX parser for PaperLeaf
import os
import re
import gzip
import time

_CACHE = {}
_CACHE_ORDER = []
MAX_CACHE_ENTRIES = 10

def get_synctex_data(synctex_path):
    if not os.path.exists(synctex_path):
        return None
        
    mtime = os.path.getmtime(synctex_path)
    cached = _CACHE.get(synctex_path)
    if cached and cached.get('mtime') == mtime:
        if synctex_path in _CACHE_ORDER:
            _CACHE_ORDER.remove(synctex_path)
            _CACHE_ORDER.append(synctex_path)
        return cached['data']
        
    try:
        with gzip.open(synctex_path, 'rt', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        return None

    # Parse inputs (tag -> filename)
    input_tags = {}
    tag_to_file = {}
    for match in re.finditer(r'Input:(\d+):([^\n\r]+)', content):
        tag = int(match.group(1))
        full_path = match.group(2).strip().replace('\\\\', '/').replace('\\', '/')
        fname = os.path.basename(full_path)
        input_tags[fname.lower()] = tag
        tag_to_file[tag] = fname

    current_page = 1
    tag_line_to_pos = {}   # (tag, line) -> list of (page, x, y, w, h)
    records_by_page = {}   # page -> list of (tag, line, x, y, w, h)

    for line in content.splitlines():
        if line.startswith('{'):
            m = re.match(r'\{(\d+)', line)
            if m:
                current_page = int(m.group(1))
                if current_page not in records_by_page:
                    records_by_page[current_page] = []
        elif line and line[0] in 'xkhgv':
            parts = line[1:].split(':')
            tag_line = parts[0].split(',')
            if len(tag_line) == 2 and len(parts) >= 2:
                try:
                    tag = int(tag_line[0])
                    lno = int(tag_line[1])
                    xy = parts[1].split(',')
                    if len(xy) >= 2:
                        x = float(xy[0]) / 65536.0
                        y = float(xy[1]) / 65536.0
                        w = 120.0
                        h = 14.0
                        if len(parts) >= 3:
                            whd = parts[2].split(',')
                            if len(whd) >= 2:
                                parsed_w = abs(float(whd[0]) / 65536.0)
                                parsed_h = abs(float(whd[1]) / 65536.0)
                                if parsed_w > 5:
                                    w = min(parsed_w, 400.0)
                                if parsed_h > 4:
                                    h = min(parsed_h, 30.0)

                        if current_page > 0:
                            rec = (tag, lno, x, y, w, h)
                            records_by_page[current_page].append(rec)
                            key = (tag, lno)
                            if key not in tag_line_to_pos:
                                tag_line_to_pos[key] = []
                            tag_line_to_pos[key].append((current_page, x, y, w, h))
                except Exception:
                    pass

    data = {
        'input_tags': input_tags,
        'tag_to_file': tag_to_file,
        'tag_line_to_pos': tag_line_to_pos,
        'records_by_page': records_by_page
    }
    if synctex_path in _CACHE_ORDER:
        _CACHE_ORDER.remove(synctex_path)
    _CACHE[synctex_path] = {'mtime': mtime, 'data': data}
    _CACHE_ORDER.append(synctex_path)

    while len(_CACHE_ORDER) > MAX_CACHE_ENTRIES:
        oldest = _CACHE_ORDER.pop(0)
        _CACHE.pop(oldest, None)

    return data

def find_pos_for_line(project_dir, filename, target_line):
    """Forward SyncTeX: find page and bounding box (x, y, w, h in pt) for a given code line."""
    synctex_path = os.path.join(project_dir, 'build', 'main.synctex.gz')
    data = get_synctex_data(synctex_path)
    if not data:
        return {'page': 1, 'x': 50, 'y': 100, 'w': 200, 'h': 16}

    clean_name = os.path.basename(filename.strip().replace('\\\\', '/').replace('\\', '/')).lower()
    target_tag = data['input_tags'].get(clean_name, 1)

    key = (target_tag, target_line)
    if key in data['tag_line_to_pos'] and data['tag_line_to_pos'][key]:
        p, x, y, w, h = data['tag_line_to_pos'][key][0]
        return {'page': p, 'x': round(x, 1), 'y': round(y, 1), 'w': round(w, 1), 'h': round(h, 1)}

    # Proximity fallback: search nearest line in the file
    all_keys = [k for k in data['tag_line_to_pos'].keys() if k[0] == target_tag]
    if not all_keys:
        return {'page': 1, 'x': 50, 'y': 100, 'w': 200, 'h': 16}

    best_key = min(all_keys, key=lambda k: abs(k[1] - target_line))
    p, x, y, w, h = data['tag_line_to_pos'][best_key][0]
    return {'page': p, 'x': round(x, 1), 'y': round(y, 1), 'w': round(w, 1), 'h': round(h, 1)}

def find_page_for_line(project_dir, filename, target_line):
    pos = find_pos_for_line(project_dir, filename, target_line)
    return pos.get('page', 1)

def find_line_for_pos(project_dir, target_page, click_x, click_y):
    """Backward SyncTeX: find source file and line for a click position on a PDF page."""
    synctex_path = os.path.join(project_dir, 'build', 'main.synctex.gz')
    data = get_synctex_data(synctex_path)
    if not data:
        return {'file': 'main.tex', 'line': 1}

    records = data['records_by_page'].get(target_page, [])
    if not records:
        # Fallback to page 1 records if page empty
        records = data['records_by_page'].get(1, [])
        if not records:
            return {'file': 'main.tex', 'line': 1}

    # Distance metric: Y distance is weighted 3x more heavily than X distance
    # because in text layouts, lines are horizontal bands.
    best_dist = 1e9
    best_rec = None

    for r in records:
        tag, lno, rx, ry, rw, rh = r
        dx = rx - click_x
        dy = ry - click_y
        dist = (dx * dx) + (dy * dy * 9.0)
        if dist < best_dist:
            best_dist = dist
            best_rec = r

    if best_rec:
        tag, lno, _, _, _, _ = best_rec
        fname = data['tag_to_file'].get(tag, 'main.tex')
        return {'file': fname, 'line': lno}

    return {'file': 'main.tex', 'line': 1}
