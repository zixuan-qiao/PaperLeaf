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

def resolve_synctex_path(project_dir, doc=None):
    """Dynamically find the generated synctex.gz in the project's build directory."""
    build_dir = os.path.join(project_dir, 'build')
    if not os.path.exists(build_dir):
        return os.path.join(build_dir, 'main.synctex.gz')

    if doc:
        clean_doc = doc.strip().replace('\\', '/')
        stem = os.path.splitext(os.path.basename(clean_doc))[0]
        specific_synctex = os.path.join(build_dir, f"{stem}.synctex.gz")
        if os.path.exists(specific_synctex):
            return specific_synctex

    # Check meta.json for last_compiled_doc or root_document
    meta_path = os.path.join(project_dir, 'meta.json')
    if os.path.exists(meta_path):
        try:
            import json
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            last_doc = meta.get('last_compiled_doc') or meta.get('root_document')
            if last_doc:
                stem = os.path.splitext(os.path.basename(last_doc))[0]
                target = os.path.join(build_dir, f"{stem}.synctex.gz")
                if os.path.exists(target):
                    return target
        except Exception:
            pass

    cands = [os.path.join(build_dir, f) for f in os.listdir(build_dir) if f.endswith('.synctex.gz')]
    if cands:
        cands.sort(key=lambda x: os.path.getmtime(x), reverse=True)
        return cands[0]
    return os.path.join(build_dir, 'main.synctex.gz')

def find_pos_for_line(project_dir, filename, target_line, doc=None):
    """Forward SyncTeX: find page and bounding box (x, y, w, h in pt) for a given code line."""
    clean_name = os.path.basename(filename.strip().replace('\\\\', '/').replace('\\', '/')).lower()

    # 1. First attempt: resolve synctex via doc parameter
    synctex_path = resolve_synctex_path(project_dir, doc=doc or filename)
    data = get_synctex_data(synctex_path) if synctex_path else None

    # 2. If data is None or clean_name is not in input_tags of this synctex file,
    # search across all .synctex.gz in build/ to find the one that includes this file
    if not data or clean_name not in data.get('input_tags', {}):
        build_dir = os.path.join(project_dir, 'build')
        if os.path.exists(build_dir):
            cands = [os.path.join(build_dir, f) for f in os.listdir(build_dir) if f.endswith('.synctex.gz')]
            for cand in cands:
                cand_data = get_synctex_data(cand)
                if cand_data and clean_name in cand_data.get('input_tags', {}):
                    synctex_path = cand
                    data = cand_data
                    break

    if not data:
        return {'page': 1, 'x': 50, 'y': 100, 'w': 200, 'h': 16}

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

def find_page_for_line(project_dir, filename, target_line, doc=None):
    pos = find_pos_for_line(project_dir, filename, target_line, doc=doc)
    return pos.get('page', 1)

def find_line_for_pos(project_dir, target_page, click_x, click_y, doc=None):
    """Backward SyncTeX: find source file and line for a click position on a PDF page."""
    synctex_path = resolve_synctex_path(project_dir, doc=doc)
    data = get_synctex_data(synctex_path)
    default_file = os.path.basename(doc.strip().replace('\\', '/')) if doc else 'main.tex'
    if not data:
        return {'file': default_file, 'line': 1}

    records = data['records_by_page'].get(target_page, [])
    if not records:
        # Fallback to page 1 records if page empty
        records = data['records_by_page'].get(1, [])
        if not records:
            return {'file': default_file, 'line': 1}

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
        fname = data['tag_to_file'].get(tag, default_file)
        return {'file': fname, 'line': lno}

    return {'file': default_file, 'line': 1}

