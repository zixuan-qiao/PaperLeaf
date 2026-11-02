import os
import sys
import time
import json
import shutil
import re
import subprocess
import threading
import urllib.parse
from flask import Flask, request, jsonify, send_file, send_from_directory
from templates import TEMPLATES
from eps_handler import preprocess_project_eps
from synctex_handler import find_page_for_line, find_pos_for_line, find_line_for_pos

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(BASE_DIR, "bin")
TECTONIC_EXE = os.path.join(BIN_DIR, "tectonic.exe")
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
FONTS_DIR = os.path.join(BASE_DIR, "fonts")
FANDOL_DIR = os.path.join(FONTS_DIR, "fandol")
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOG_FILE = os.path.join(DATA_DIR, "server.log")

def log_msg(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass

def is_safe_subpath(base_dir, target_path):
    try:
        base_abs = os.path.abspath(base_dir)
        target_abs = os.path.abspath(target_path)
        return os.path.commonpath([base_abs, target_abs]) == base_abs
    except Exception:
        return False

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(PROJECTS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app = Flask(__name__, static_folder=STATIC_DIR)
app.config['MAX_CONTENT_LENGTH'] = 150 * 1024 * 1024  # 150 MB max upload for large papers with figures
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

@app.after_request
def add_no_cache_headers(response):
    if request.path.startswith('/static/') or request.path == '/':
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        if response.mimetype == 'application/javascript':
            response.headers['Content-Type'] = 'application/javascript; charset=utf-8'
        elif response.mimetype == 'text/css':
            response.headers['Content-Type'] = 'text/css; charset=utf-8'
        elif response.mimetype == 'text/html':
            response.headers['Content-Type'] = 'text/html; charset=utf-8'
    return response

# Heartbeat tracking for automatic shutdown when window closes
last_heartbeat_time = time.time()
server_start_time = time.time()
has_received_first_heartbeat = False

def heartbeat_monitor():
    """If no heartbeat received for 120 seconds after window opened, automatically exit cleanly"""
    global last_heartbeat_time, has_received_first_heartbeat
    while True:
        time.sleep(3)
        now = time.time()
        # Give 120s timeout so user browsing file dialogs or switching windows is never disconnected
        if has_received_first_heartbeat and (now - last_heartbeat_time > 120):
            log_msg(f"[EXIT] No heartbeat from frontend window for >120s. Shutting down. last={last_heartbeat_time}, now={now}")
            os._exit(0)
        elif not has_received_first_heartbeat and (now - server_start_time > 60):
            log_msg(f"[EXIT] Frontend window never connected within 60s. Shutting down. start={server_start_time}, now={now}")
            os._exit(0)

threading.Thread(target=heartbeat_monitor, daemon=True).start()

def parse_tectonic_errors(stderr_text):
    errors = []
    lines = stderr_text.splitlines()
    for i, line in enumerate(lines):
        if "fontconfig error" in line.lower():
            continue
        file_line_match = re.search(r'([\w\-./\\]+\.tex):(\d+):', line)
        if not file_line_match:
            file_line_match = re.search(r'(?:error:\s*)?([\w\-./\\]+):(\d+):', line)
        colon_line_match = re.search(r':(\d+):', line)
        line_match = re.search(r'line\s+(\d+)', line, re.IGNORECASE)
        l_num_match = re.search(r'^l\.(\d+)', line)
        if "error:" in line.lower() or line.startswith("!"):
            line_no = None
            err_file = None
            if file_line_match:
                err_file = os.path.basename(file_line_match.group(1))
                line_no = int(file_line_match.group(2))
            elif colon_line_match:
                line_no = int(colon_line_match.group(1))
            elif line_match:
                line_no = int(line_match.group(1))
            elif l_num_match:
                line_no = int(l_num_match.group(1))
            elif i + 1 < len(lines):
                next_line = lines[i+1]
                next_file_match = re.search(r'([\w\-./\\]+\.tex):(\d+):', next_line)
                if next_file_match:
                    err_file = os.path.basename(next_file_match.group(1))
                    line_no = int(next_file_match.group(2))
                else:
                    next_match = (re.search(r':(\d+):', next_line) or
                                  re.search(r'line\s+(\d+)', next_line, re.IGNORECASE) or 
                                  re.search(r'^l\.(\d+)', next_line))
                    if next_match:
                        line_no = int(next_match.group(1))
            errors.append({
                "line": line_no or 1,
                "file": err_file or "",
                "message": line.strip()
            })
    return errors

def analyze_compile_diagnostics(log_text, tex_path):
    """Analyze compiler log for subtle layout/font degradations and provide smart quick-fix actions."""
    diagnostics = []
    if not log_text:
        return diagnostics

    tex_content = ""
    if os.path.exists(tex_path):
        try:
            with open(tex_path, "r", encoding="utf-8", errors="ignore") as f:
                tex_content = f.read()
        except Exception:
            pass

    # 1. Font fallback detection (e.g. Font shape `TU/ptm/m/n' undefined using `TU/lmr/m/n' instead)
    font_fallback_match = re.search(r"Font shape `TU/([a-zA-Z0-9_-]+)/[^']*' undefined\s*\(Font\)\s*using `TU/lmr/", log_text)
    if font_fallback_match:
        missing_font = font_fallback_match.group(1)
        font_name_hint = "Times Roman" if missing_font == "ptm" else ("Helvetica" if missing_font == "phv" else ("Palatino" if missing_font == "ppl" else missing_font))
        if "fontenc" not in tex_content:
            diagnostics.append({
                "id": "font_fallback_t1",
                "type": "warning",
                "icon": "📐",
                "title": f"排版智能建议：检测到正文字体（{font_name_hint}）被降级为宽体",
                "description": f"当前模板使用了传统的 8 位字体定义（{missing_font}），在现代 Unicode 引擎中被自动保底降级为 Latin Modern 宽体，导致每行容纳字数变少、排版偏宽（可能比 Overleaf 多出页数）。建议引入 [T1]{{fontenc}} 锁定官方标准紧凑印刷体，与 Overleaf 1:1 对齐。",
                "action": "insert_package",
                "package_code": "\\usepackage[T1]{fontenc}",
                "action_label": "一键对齐 Overleaf (添加 [T1]{fontenc})"
            })

    return diagnostics

FANDOL_DEF_CONTENT = r"""%%
\ProvidesExplFile{ctex-fontset-fandol.def}
  {\ExplFileDate}{2.5.8}{Fandol fonts for PaperLeaf}
\ctex_fontset_case:nnnn
  { \ctex_fontset_error:n { fandol } }
  {
    \setCJKmainfont { FandolSong-Regular.otf }
      [
        BoldFont   = FandolSong-Bold.otf,
        ItalicFont = FandolKai-Regular.otf
      ]
    \setCJKsansfont { FandolHei-Regular.otf }
      [ BoldFont = FandolHei-Bold.otf ]
    \setCJKmonofont { FandolFang-Regular.otf }
    \setCJKfamilyfont { zhsong } { FandolSong-Regular.otf }
      [ BoldFont = FandolSong-Bold.otf ]
    \setCJKfamilyfont { zhhei  } { FandolHei-Regular.otf  }
      [ BoldFont = FandolHei-Bold.otf  ]
    \setCJKfamilyfont { zhfs   } { FandolFang-Regular.otf }
    \setCJKfamilyfont { zhkai  } { FandolKai-Regular.otf  }
    \ctex_punct_set:n { fandol }
    \ctex_punct_map_family:nn   { \CJKrmdefault         } { zhsong  }
    \ctex_punct_map_family:nn   { \CJKsfdefault         } { zhhei   }
    \ctex_punct_map_family:nn   { \CJKttdefault         } { zhfs    }
    \ctex_punct_map_itshape:nn  { \CJKrmdefault         } { zhkai   }
  }
  { \ctex_fontset_error:n { fandol } }
  {
    \setCJKmainfont { FandolSong-Regular }
      [
        Extension  = .otf,
        BoldFont   = FandolSong-Bold,
        ItalicFont = FandolKai-Regular
      ]
    \setCJKsansfont { FandolHei-Regular }
      [ Extension = .otf, BoldFont = FandolHei-Bold ]
    \setCJKmonofont { FandolFang-Regular }
      [ Extension = .otf ]
    \setCJKfamilyfont { zhsong } { FandolSong-Regular }
      [ Extension = .otf, BoldFont = FandolSong-Bold ]
    \setCJKfamilyfont { zhhei  } { FandolHei-Regular }
      [ Extension = .otf, BoldFont = FandolHei-Bold ]
    \setCJKfamilyfont { zhfs   } { FandolFang-Regular }
      [ Extension = .otf ]
    \setCJKfamilyfont { zhkai  } { FandolKai-Regular }
      [ Extension = .otf ]
  }
\NewDocumentCommand \songti   { } { \CJKfamily { zhsong  } }
\NewDocumentCommand \heiti    { } { \CJKfamily { zhhei   } }
\NewDocumentCommand \fangsong { } { \CJKfamily { zhfs    } }
\NewDocumentCommand \kaishu   { } { \CJKfamily { zhkai   } }
"""

def ensure_global_ctex_font_shim():
    """Ensure ctex-fontset-fandol.def is present in global FANDOL_DIR for Tectonic search-path."""
    if not os.path.exists(FANDOL_DIR):
        return
    fandol_def_path = os.path.join(FANDOL_DIR, "ctex-fontset-fandol.def")
    if not os.path.exists(fandol_def_path):
        try:
            with open(fandol_def_path, "w", encoding="utf-8") as f:
                f.write(FANDOL_DEF_CONTENT)
        except Exception as e:
            print("[WARN] Failed to write global ctex font shim:", e)

_cleaned_projects = set()

def cleanup_legacy_font_pollution(project_dir):
    """Purge legacy physical Fandol*.otf and ctex-fontset-fandol.def from project directory."""
    if project_dir in _cleaned_projects:
        return
    if not os.path.exists(project_dir):
        return
    try:
        for f in os.listdir(project_dir):
            if f == "ctex-fontset-fandol.def" or (f.startswith("Fandol") and f.endswith(".otf")):
                try:
                    os.remove(os.path.join(project_dir, f))
                except Exception:
                    pass
        _cleaned_projects.add(project_dir)
    except Exception:
        pass

def get_project_root_document(project_id):
    """Resolve the designated entry/root document (.tex) for a project."""
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    meta_file = os.path.join(p_dir, "meta.json")
    root_doc = "main.tex"
    if os.path.exists(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
                root_doc = meta.get("root_document", "main.tex")
        except Exception:
            pass

    if os.path.exists(os.path.join(p_dir, root_doc)):
        return root_doc

    if os.path.exists(os.path.join(p_dir, "main.tex")):
        return "main.tex"

    for root, dirs, files in os.walk(p_dir):
        dirs[:] = [d for d in dirs if d not in ("build", ".history", "__pycache__")]
        for f in files:
            if f.lower().endswith(".tex"):
                return os.path.relpath(os.path.join(root, f), p_dir).replace("\\", "/")
    return "main.tex"

def ensure_initial_projects():
    ensure_global_ctex_font_shim()
    existing = [d for d in os.listdir(PROJECTS_DIR) if os.path.isdir(os.path.join(PROJECTS_DIR, d))]
    for d in existing:
        cleanup_legacy_font_pollution(os.path.join(PROJECTS_DIR, d))
    if not existing:
        create_project_internal("demo_chinese", "中文学术论文示例", "chinese")
        create_project_internal("demo_english", "English Research Demo", "english")

def create_project_internal(project_id, name, template_key="chinese"):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    os.makedirs(p_dir, exist_ok=True)
    tpl = TEMPLATES.get(template_key, TEMPLATES.get("chinese", {}))
    lang = tpl.get("language", "english" if template_key == "english" else "chinese")
    meta = {
        "id": project_id,
        "name": name,
        "language": lang,
        "template": template_key,
        "root_document": "main.tex",
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "has_pdf": False
    }
    with open(os.path.join(p_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    
    tex_content = tpl.get("content", TEMPLATES["chinese"]["content"])
    with open(os.path.join(p_dir, "main.tex"), "w", encoding="utf-8") as f:
        f.write(tex_content)
    return meta

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/api/system/heartbeat", methods=["GET", "POST"])
def heartbeat():
    global last_heartbeat_time, has_received_first_heartbeat
    last_heartbeat_time = time.time()
    has_received_first_heartbeat = True
    return jsonify({"status": "alive"})

def cleanup_zombie_edge():
    """Kill any stale Edge processes that locked our isolated edge_profile"""
    try:
        import psutil
        for p in psutil.process_iter(['name']):
            try:
                name = (p.info.get('name') or '').lower()
                if 'msedge' in name:
                    cmdline = ' '.join(p.cmdline())
                    if 'edge_profile' in cmdline:
                        p.kill()
            except Exception:
                pass
    except Exception:
        pass

@app.route("/api/system/shutdown", methods=["POST"])
def shutdown():
    print("[INFO] Shutdown requested by user.")
    def do_exit():
        time.sleep(0.3)
        cleanup_zombie_edge()
        time.sleep(0.2)
        os._exit(0)
    threading.Thread(target=do_exit).start()
    return jsonify({"status": "shutting_down"})

@app.route("/api/projects/<project_id>/files", methods=["GET"])
def list_project_files(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"error": "Project not found"}), 404
        
    cleanup_legacy_font_pollution(p_dir)
    root_doc = get_project_root_document(project_id)

    files_list = []
    for root, dirs, files in os.walk(p_dir):
        # Prune dirs in-place to avoid descending into build, .history, __pycache__
        dirs[:] = [d for d in dirs if d not in ("build", ".history", "__pycache__")]
        for d in dirs:
            r_path = os.path.relpath(os.path.join(root, d), p_dir).replace("\\", "/")
            files_list.append({
                "name": d,
                "path": r_path,
                "is_dir": True,
                "ext": "folder"
            })
        for f in files:
            if f == "meta.json" or f.endswith(".zip") or f == "ctex-fontset-fandol.def" or (f.startswith("Fandol") and f.endswith(".otf")):
                continue
            r_path = os.path.relpath(os.path.join(root, f), p_dir).replace("\\", "/")
            ext = os.path.splitext(f)[1].lower().lstrip(".")
            is_root = (r_path.lower() == root_doc.lower())
            files_list.append({
                "name": f,
                "path": r_path,
                "is_dir": False,
                "ext": ext,
                "size": os.path.getsize(os.path.join(root, f)),
                "is_root": is_root
            })
            
    def sort_key(item):
        parts = item["path"].replace("\\", "/").split("/")
        key = []
        for idx, p in enumerate(parts):
            is_last = (idx == len(parts) - 1)
            is_d = item["is_dir"] if is_last else True
            key.append((0 if is_d else 1, p.lower()))
        return key

    files_list.sort(key=sort_key)
    return jsonify({"files": files_list, "root_document": root_doc})

@app.route("/api/projects/<project_id>/set_root_document", methods=["POST"])
def set_root_document(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "error": "项目不存在"}), 404
        
    data = request.json or {}
    root_doc = data.get("root_document", "").strip().lstrip("/\\")
    if not root_doc or not root_doc.lower().endswith(".tex"):
        return jsonify({"success": False, "error": "主文档必须为 .tex 文件"}), 400
        
    target_path = os.path.abspath(os.path.join(p_dir, root_doc))
    if not is_safe_subpath(p_dir, target_path) or not os.path.exists(target_path):
        return jsonify({"success": False, "error": f"找不到指定文件: {root_doc}"}), 404
        
    meta_file = os.path.join(p_dir, "meta.json")
    meta = {}
    if os.path.exists(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
        except Exception:
            pass
    meta["root_document"] = root_doc
    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(meta_file, "w", encoding="utf-8") as mf:
        json.dump(meta, mf, ensure_ascii=False, indent=2)
        
    return jsonify({"success": True, "root_document": root_doc})

@app.route("/api/projects/<project_id>/upload_file", methods=["POST"])
def upload_project_file(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"error": "Project not found"}), 404
        
    target_dir = request.form.get("target_dir", "").strip().lstrip("/\\")
    dest_dir = os.path.abspath(os.path.join(p_dir, target_dir))
    if not is_safe_subpath(p_dir, dest_dir):
        return jsonify({"error": "非法目录路径"}), 400
        
    os.makedirs(dest_dir, exist_ok=True)
    uploaded_files = request.files.getlist("files")
    saved_names = []
    
    for f in uploaded_files:
        if f.filename:
            safe_name = os.path.basename(f.filename)
            save_path = os.path.join(dest_dir, safe_name)
            f.save(save_path)
            saved_names.append(safe_name)
            
    return jsonify({"success": True, "uploaded": saved_names})

@app.route("/api/projects/<project_id>/create_file", methods=["POST"])
def create_project_file(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"error": "Project not found"}), 404
        
    data = request.json or {}
    rel_path = data.get("path", "").strip().lstrip("/\\")
    is_dir = data.get("is_dir", False)
    
    if not rel_path:
        return jsonify({"error": "文件名不能为空"}), 400
        
    target_path = os.path.abspath(os.path.join(p_dir, rel_path))
    if not is_safe_subpath(p_dir, target_path):
        return jsonify({"error": "非法路径"}), 400
        
    if is_dir:
        os.makedirs(target_path, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        if not os.path.exists(target_path):
            with open(target_path, "w", encoding="utf-8") as f:
                f.write("% " + rel_path + "\n")
                
    return jsonify({"success": True})

@app.route("/api/projects/<project_id>/delete_file", methods=["POST"])
def delete_project_file(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    data = request.json or {}
    rel_path = data.get("path", "").strip().lstrip("/\\")
    
    root_doc = get_project_root_document(project_id)
    if not rel_path or rel_path.lower() == root_doc.lower():
        return jsonify({"error": f"不能删除当前主文档 ({root_doc})。如需删除，请先将其他 .tex 文件设为主文档"}), 400
        
    if rel_path in (".history", "meta.json", "build") or rel_path.startswith(".history/") or rel_path.startswith(".history\\") or rel_path.startswith("build/") or rel_path.startswith("build\\"):
        return jsonify({"error": "禁止删除系统关键元数据或内部系统目录"}), 400
        
    target_path = os.path.abspath(os.path.join(p_dir, rel_path))
    if not is_safe_subpath(p_dir, target_path):
        return jsonify({"error": "非法路径"}), 400
        
    if os.path.isdir(target_path):
        shutil.rmtree(target_path, ignore_errors=True)
    elif os.path.exists(target_path):
        os.remove(target_path)
        
    return jsonify({"success": True})

@app.route("/api/projects/<project_id>/rename_file", methods=["POST"])
def rename_project_file(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "error": "项目不存在"}), 404
        
    data = request.json or {}
    old_rel = data.get("old_path", "").strip().lstrip("/\\")
    new_name = data.get("new_name", "").strip().lstrip("/\\")
    if not old_rel or not new_name:
        return jsonify({"success": False, "error": "原路径与新名称不能为空"}), 400
        
    if re.search(r'[\\/*?:"<>|]', new_name):
        return jsonify({"success": False, "error": "名称包含非法字符"}), 400
        
    if old_rel in (".history", "meta.json", "build") or old_rel.startswith(".history/") or old_rel.startswith("build/"):
        return jsonify({"success": False, "error": "禁止重命名系统关键文件或目录"}), 400
        
    old_target = os.path.abspath(os.path.join(p_dir, old_rel))
    if not is_safe_subpath(p_dir, old_target) or not os.path.exists(old_target):
        return jsonify({"success": False, "error": "原文件或目录不存在"}), 404
        
    parent_dir = os.path.dirname(old_target)
    new_target = os.path.abspath(os.path.join(parent_dir, new_name))
    if not is_safe_subpath(p_dir, new_target):
        return jsonify({"success": False, "error": "非法目标路径"}), 400
        
    if os.path.exists(new_target):
        return jsonify({"success": False, "error": "目标名称已存在，请换一个名称"}), 400
        
    try:
        os.rename(old_target, new_target)
    except Exception as e:
        return jsonify({"success": False, "error": f"重命名失败: {str(e)}"}), 500
        
    # If the renamed file was root_document, update meta.json
    meta_file = os.path.join(p_dir, "meta.json")
    new_rel = os.path.relpath(new_target, p_dir).replace("\\", "/")
    if os.path.exists(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
            if meta.get("root_document") == old_rel:
                meta["root_document"] = new_rel
                meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                with open(meta_file, "w", encoding="utf-8") as mf:
                    json.dump(meta, mf, ensure_ascii=False, indent=2)
        except Exception:
            pass
            
    return jsonify({"success": True, "old_path": old_rel, "new_path": new_rel})

@app.route("/api/projects/<project_id>/open_folder", methods=["POST"])
def open_project_folder(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if os.path.exists(p_dir):
        os.startfile(p_dir)
        return jsonify({"success": True})
    return jsonify({"error": "Not found"}), 404

@app.route("/api/projects/<project_id>/raw/<path:rel_path>", methods=["GET"])
def get_project_raw_file(project_id, rel_path):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    target = os.path.abspath(os.path.join(p_dir, rel_path))
    if not is_safe_subpath(p_dir, target) or not os.path.exists(target):
        return "File not found", 404
    as_attachment = request.args.get("download", "0") == "1"
    filename = os.path.basename(target)
    return send_file(target, as_attachment=as_attachment, download_name=filename)

@app.route("/api/projects", methods=["GET"])
def list_projects():
    projects = []
    for d in os.listdir(PROJECTS_DIR):
        p_dir = os.path.join(PROJECTS_DIR, d)
        if os.path.isdir(p_dir):
            meta_file = os.path.join(p_dir, "meta.json")
            if os.path.exists(meta_file):
                with open(meta_file, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            else:
                meta = {
                    "id": d,
                    "name": d,
                    "language": "chinese" if "cn" in d or "chinese" in d else "english",
                    "created_at": "",
                    "updated_at": ""
                }
            root_doc = get_project_root_document(d)
            meta["root_document"] = root_doc
            doc_stem = os.path.splitext(os.path.basename(root_doc))[0]
            pdf_path = os.path.join(p_dir, "build", f"{doc_stem}.pdf")
            has_pdf = os.path.exists(pdf_path)
            if not has_pdf and os.path.exists(os.path.join(p_dir, "build")):
                has_pdf = any(f.lower().endswith(".pdf") for f in os.listdir(os.path.join(p_dir, "build")))
            meta["has_pdf"] = has_pdf
            projects.append(meta)
    projects.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return jsonify({"projects": projects})

def detect_latex_language(tex_path):
    """
    Intelligently detect whether a LaTeX document is Chinese (CTeX) or English (Standard).
    Strips % comments first to prevent misclassifying English papers that contain Chinese author notes.
    """
    if not os.path.exists(tex_path):
        return "english"
    try:
        with open(tex_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read(15000)
    except Exception:
        return "english"

    lower_content = content.lower()
    ctex_classes = ["ctexart", "ctexrep", "ctexbook", "ctexbeamer"]
    for cls in ctex_classes:
        if "\\documentclass" in lower_content and cls in lower_content:
            return "chinese"

    if "\\usepackage{ctex}" in lower_content or "\\usepackage[utf8]{ctex}" in lower_content or "\\usepackage{xecjk}" in lower_content:
        return "chinese"

    # Strip comments to inspect actual printable body
    non_comment_lines = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("%"):
            continue
        code_part = re.split(r'(?<!\\)%', line)[0]
        if code_part.strip():
            non_comment_lines.append(code_part)
            
    body_text = "\n".join(non_comment_lines)
    chinese_chars = sum(1 for char in body_text if '\u4e00' <= char <= '\u9fff')
    if chinese_chars >= 30:
        return "chinese"
        
    return "english"

@app.route("/api/projects/upload_zip", methods=["POST"])
def upload_zip():
    global last_heartbeat_time
    last_heartbeat_time = time.time()
    
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "未选择任何 ZIP 文件"}), 400
    f = request.files['file']
    if not f.filename or not f.filename.lower().endswith('.zip'):
        return jsonify({"success": False, "error": "请上传 .zip 格式压缩包"}), 400
    
    # Clean project name from zip filename
    raw_name = os.path.splitext(os.path.basename(f.filename))[0].strip()
    try:
        raw_name = raw_name.encode('iso-8859-1').decode('utf-8')
    except Exception:
        pass
    clean_name = raw_name or f"导入项目_{int(time.time())}"
    project_id = f"project_{int(time.time())}"
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    os.makedirs(p_dir, exist_ok=True)
    
    zip_path = os.path.join(p_dir, "_temp.zip")
    f.save(zip_path)
    
    try:
        import zipfile
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for member in zip_ref.infolist():
                # Correct encoding for non-UTF8 zip files (Windows GBK)
                filename = member.filename
                if not (member.flag_bits & 0x800):
                    try:
                        filename = member.filename.encode('cp437').decode('gbk')
                    except Exception:
                        try:
                            filename = member.filename.encode('cp437').decode('utf-8')
                        except Exception:
                            pass
                
                # Prevent zip slip path traversal
                extracted_path = os.path.abspath(os.path.join(p_dir, filename))
                if not is_safe_subpath(p_dir, extracted_path):
                    continue
                
                if member.is_dir():
                    os.makedirs(extracted_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(extracted_path), exist_ok=True)
                    with zip_ref.open(member) as source, open(extracted_path, "wb") as target:
                        shutil.copyfileobj(source, target)
                        
        if os.path.exists(zip_path):
            os.remove(zip_path)
        
        # Flatten single directory if all contents are inside a root folder
        items = [x for x in os.listdir(p_dir) if not x.startswith('_')]
        if len(items) == 1 and os.path.isdir(os.path.join(p_dir, items[0])):
            single_folder = os.path.join(p_dir, items[0])
            for sub in os.listdir(single_folder):
                shutil.move(os.path.join(single_folder, sub), p_dir)
            try:
                os.rmdir(single_folder)
            except Exception:
                pass
                
        # Smart root document detection
        main_tex = os.path.join(p_dir, "main.tex")
        root_doc_rel = "main.tex"
        if os.path.exists(main_tex):
            root_doc_rel = "main.tex"
        else:
            tex_candidates = []
            for root, dirs, files in os.walk(p_dir):
                for file in files:
                    if file.lower().endswith(".tex"):
                        tex_candidates.append(os.path.join(root, file))
            
            if tex_candidates:
                best_file = tex_candidates[0]
                for tc in tex_candidates:
                    try:
                        with open(tc, "r", encoding="utf-8", errors="ignore") as f_cand:
                            txt = f_cand.read()
                            if "\\documentclass" in txt:
                                best_file = tc
                                break
                    except Exception:
                        pass
                root_doc_rel = os.path.relpath(best_file, p_dir).replace("\\", "/")
            else:
                with open(main_tex, "w", encoding="utf-8") as f_out:
                    f_out.write(TEMPLATES["chinese"]["content"])
                root_doc_rel = "main.tex"
        
        # Smart detect language from root document
        target_root_full = os.path.join(p_dir, root_doc_rel)
        detected_lang = detect_latex_language(target_root_full)
            
        meta = {
            "id": project_id,
            "name": clean_name,
            "language": detected_lang,
            "root_document": root_doc_rel,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "has_pdf": False
        }
        with open(os.path.join(p_dir, "meta.json"), "w", encoding="utf-8") as mf:
            json.dump(meta, mf, ensure_ascii=False, indent=2)
            
        cleanup_legacy_font_pollution(p_dir)
        ensure_global_ctex_font_shim()
        try:
            preprocess_project_eps(p_dir)
        except Exception as epse:
            print("[WARN] EPS preprocessing error on upload:", epse)
            
        last_heartbeat_time = time.time()
        return jsonify({"success": True, "project": meta})
    except Exception as e:
        shutil.rmtree(p_dir, ignore_errors=True)
        return jsonify({"success": False, "error": f"解压失败: {str(e)}"}), 500

@app.route("/api/projects/<project_id>/export_zip", methods=["GET"])
def export_zip(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return "Project not found", 404
        
    folder = request.args.get("folder", "").strip().lstrip("/\\")
    if folder:
        target_dir = os.path.abspath(os.path.join(p_dir, folder))
        if not is_safe_subpath(p_dir, target_dir) or not os.path.isdir(target_dir):
            return "Folder not found", 404
        import zipfile
        import io
        memory_zip = io.BytesIO()
        with zipfile.ZipFile(memory_zip, 'w', zipfile.ZIP_DEFLATED) as zip_out:
            for root, dirs, files in os.walk(target_dir):
                for file in files:
                    full_path = os.path.join(root, file)
                    arcname = os.path.relpath(full_path, target_dir)
                    zip_out.write(full_path, arcname)
        memory_zip.seek(0)
        safe_folder_name = re.sub(r'[\\/*?:"<>|]', '_', os.path.basename(target_dir)).strip() or "folder"
        return send_file(memory_zip, mimetype="application/zip", as_attachment=True, download_name=f"{safe_folder_name}.zip")

    is_clean = request.args.get("clean") == "true"
    import zipfile
    import io
    meta_file = os.path.join(p_dir, "meta.json")
    proj_name = project_id
    if os.path.exists(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                proj_name = json.load(f).get("name", project_id)
        except Exception:
            pass
            
    suffix = "_clean" if is_clean else ""
    
    # Extensions and files to exclude in clean mode (compiler intermediates)
    JUNK_EXTS = {".aux", ".log", ".synctex.gz", ".fls", ".fdb_latexmk", ".out", ".xdv", ".toc", ".lot", ".lof", ".nav", ".snm", ".vrb"}
    
    memory_zip = io.BytesIO()
    with zipfile.ZipFile(memory_zip, 'w', zipfile.ZIP_DEFLATED) as zip_out:
        for root, dirs, files in os.walk(p_dir):
            rel_dir = os.path.relpath(root, p_dir)
            if rel_dir == "build" or rel_dir.startswith("build" + os.sep):
                continue
            if rel_dir == ".history" or rel_dir.startswith(".history" + os.sep):
                continue
            for file in files:
                if file.endswith(".zip") or file.startswith("_temp") or file == "ctex-fontset-fandol.def" or (file.startswith("Fandol") and file.endswith(".otf")):
                    continue
                if is_clean:
                    if file == "meta.json":
                        continue
                    ext = os.path.splitext(file)[1].lower()
                    if ext in JUNK_EXTS:
                        continue
                full_path = os.path.join(root, file)
                arcname = os.path.relpath(full_path, p_dir)
                zip_out.write(full_path, arcname)
                
    memory_zip.seek(0)
    safe_name = re.sub(r'[\\/*?:"<>|]', '_', proj_name).strip() or "project"
    dl_name = f"{safe_name}{suffix}.zip"
    return send_file(memory_zip, mimetype="application/zip", as_attachment=True, download_name=dl_name)

@app.route("/api/templates", methods=["GET"])
def get_templates():
    tpl_list = []
    for tid, tpl in TEMPLATES.items():
        tpl_list.append({
            "id": tid,
            "name": tpl.get("name", tid),
            "category": tpl.get("category", "通用"),
            "icon": tpl.get("icon", "📄"),
            "badge": tpl.get("badge", ""),
            "language": tpl.get("language", "english"),
            "description": tpl.get("description", "")
        })
    return jsonify({"success": True, "templates": tpl_list})

@app.route("/api/projects", methods=["POST"])
def create_project():
    data = request.json or {}
    name = data.get("name", "").strip() or "未命名项目"
    template_key = data.get("template") or data.get("language") or "chinese"
    project_id = f"project_{int(time.time())}"
    meta = create_project_internal(project_id, name, template_key)
    return jsonify({"success": True, "project": meta})

@app.route("/api/projects/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if os.path.exists(p_dir):
        shutil.rmtree(p_dir, ignore_errors=True)
        return jsonify({"success": True, "message": f"项目 {project_id} 及其所有生成文件已彻底清理"})
    return jsonify({"success": False, "message": "项目不存在"}), 404

@app.route("/api/projects/<project_id>/rename", methods=["POST"])
def rename_project(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    meta_file = os.path.join(p_dir, "meta.json")
    if not os.path.exists(meta_file):
        return jsonify({"success": False, "error": "项目不存在"}), 404
        
    data = request.get_json(silent=True) or {}
    new_name = data.get("name", "").strip()
    if not new_name:
        return jsonify({"success": False, "error": "项目名称不能为空"}), 400
        
    try:
        with open(meta_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["name"] = new_name
        meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "project": meta, "name": new_name})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/projects/<project_id>/set_language", methods=["POST"])
def set_project_language(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    meta_file = os.path.join(p_dir, "meta.json")
    if not os.path.exists(meta_file):
        return jsonify({"success": False, "error": "项目不存在"}), 404
        
    data = request.get_json(silent=True) or {}
    new_lang = data.get("language", "").strip().lower()
    if new_lang not in ("chinese", "english"):
        return jsonify({"success": False, "error": "不支持的语言类型，仅支持 chinese 或 english"}), 400
        
    try:
        with open(meta_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["language"] = new_lang
        meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "project": meta})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/projects/<project_id>/content", methods=["GET"])
def get_content(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    rel_path = request.args.get("path", "main.tex").strip().lstrip("/\\")
    file_path = os.path.join(p_dir, rel_path)
    if not os.path.exists(file_path):
        return jsonify({"error": f"{rel_path} not found"}), 404
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        try:
            with open(file_path, "r", encoding="gbk") as f:
                content = f.read()
        except Exception:
            return jsonify({"error": "二进制或非文本文件无法直接在此编辑"}), 400
    return jsonify({"content": content, "path": rel_path})

@app.route("/api/projects/<project_id>/content", methods=["POST"])
def save_content(project_id):
    content = ""
    rel_path = request.args.get("path", "main.tex").strip().lstrip("/\\")
    if request.is_json and request.json:
        content = request.json.get("content", "")
        if "path" in request.json:
            rel_path = request.json["path"].strip().lstrip("/\\")
    else:
        raw = request.get_data(as_text=True)
        try:
            parsed = json.loads(raw)
            content = parsed.get("content", "")
            if "path" in parsed:
                rel_path = parsed["path"].strip().lstrip("/\\")
        except Exception:
            content = raw

    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "error": "项目不存在"}), 404

    # Security check: ensure path is within project directory
    file_path = os.path.abspath(os.path.join(p_dir, rel_path))
    if not is_safe_subpath(p_dir, file_path):
        return jsonify({"success": False, "error": "非法文件路径"}), 400

    if rel_path in (".history", "meta.json", "build") or rel_path.startswith(".history/") or rel_path.startswith(".history\\") or rel_path.startswith("build/") or rel_path.startswith("build\\"):
        return jsonify({"success": False, "error": "禁止修改系统元数据或内部目录"}), 400

    # Binary / Non-editable file safety protection
    ext = os.path.splitext(rel_path)[1].lower()
    NON_EDITABLE_EXTS = {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp",
        ".pdf", ".eps", ".ps", ".ai",
        ".zip", ".tar", ".gz", ".7z", ".rar",
        ".exe", ".dll", ".so", ".bin",
        ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".ico"
    }
    if ext in NON_EDITABLE_EXTS:
        return jsonify({"success": False, "error": f"禁止将文本内容覆盖至二进制/媒体文件 ({ext})"}), 400

    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    
    meta_file = os.path.join(PROJECTS_DIR, project_id, "meta.json")
    if os.path.exists(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            with open(meta_file, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return jsonify({"success": True, "saved_at": time.strftime("%H:%M:%S")})

@app.route("/api/projects/<project_id>/compile", methods=["POST"])
def compile_project(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "error": "项目不存在"}), 404

    root_doc = get_project_root_document(project_id)
    tex_path = os.path.join(p_dir, root_doc)
    build_dir = os.path.join(p_dir, "build")
    os.makedirs(build_dir, exist_ok=True)
    
    data = request.get_json(silent=True) or {}
    if "content" in data and data["content"] is not None:
        save_target = tex_path
        if "path" in data and data["path"]:
            candidate_target = os.path.abspath(os.path.join(p_dir, data["path"].strip().lstrip("/\\")))
            if is_safe_subpath(p_dir, candidate_target):
                save_target = candidate_target
        content_to_save = data["content"]
        # Defense: Never overwrite non-empty disk file with empty or whitespace-only content
        if os.path.exists(save_target) and os.path.getsize(save_target) > 0 and len(content_to_save.strip()) == 0:
            pass
        else:
            with open(save_target, "w", encoding="utf-8") as f:
                f.write(content_to_save)

    # Determine compile target: if active document is a standalone LaTeX document, compile it!
    compile_doc = root_doc
    target_param = (data.get("compile_target") or data.get("path") or "").strip().lstrip("/\\")
    if target_param and target_param.lower().endswith(".tex"):
        cand_abs = os.path.abspath(os.path.join(p_dir, target_param))
        if is_safe_subpath(p_dir, cand_abs) and os.path.exists(cand_abs):
            try:
                with open(cand_abs, "r", encoding="utf-8", errors="ignore") as f:
                    head_sample = f.read(15000)
                if "\\documentclass" in head_sample or "\\begin{document}" in head_sample:
                    compile_doc = target_param
            except Exception:
                pass

    tex_path = os.path.join(p_dir, compile_doc)
    if not os.path.exists(tex_path):
        compile_doc = root_doc
        tex_path = os.path.join(p_dir, compile_doc)

    if not os.path.exists(tex_path):
        return jsonify({"success": False, "error": f"主编译文档不存在: {compile_doc}"}), 400

    env = os.environ.copy()
    env["TECTONIC_CACHE_DIR"] = CACHE_DIR

    cleanup_legacy_font_pollution(p_dir)
    ensure_global_ctex_font_shim()
    try:
        preprocess_project_eps(p_dir)
    except Exception as epse:
        print("[WARN] EPS preprocessing error on compile:", epse)

    start_time = time.time()
    cmd = [TECTONIC_EXE, "-Z", f"search-path={FANDOL_DIR}", "--synctex", "--print", "-o", build_dir, tex_path]
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    
    try:
        res = subprocess.run(
            cmd,
            env=env,
            cwd=p_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            creationflags=creation_flags
        )
        elapsed = round(time.time() - start_time, 2)
        doc_stem = os.path.splitext(os.path.basename(compile_doc))[0]
        pdf_path = os.path.join(build_dir, f"{doc_stem}.pdf")
        if not os.path.exists(pdf_path):
            candidates = [os.path.join(build_dir, f) for f in os.listdir(build_dir) if f.lower().endswith(".pdf")]
            if candidates:
                candidates.sort(key=lambda x: os.path.getmtime(x), reverse=True)
                pdf_path = candidates[0]
        
        if res.returncode == 0 and os.path.exists(pdf_path):
            meta_file = os.path.join(p_dir, "meta.json")
            if os.path.exists(meta_file):
                try:
                    with open(meta_file, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                    meta["has_pdf"] = True
                    meta["last_compiled_doc"] = compile_doc
                    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    with open(meta_file, "w", encoding="utf-8") as mf:
                        json.dump(meta, mf, ensure_ascii=False, indent=2)
                except Exception:
                    pass

            try:
                create_project_snapshot(project_id, comment=f"编译成功快照 ({elapsed}s)", starred=False)
            except Exception as se:
                print("[WARN] Error creating compile snapshot:", se)

            full_log = (res.stdout or "") + "\n" + (res.stderr or "")
            diagnostics = analyze_compile_diagnostics(full_log, tex_path)

            return jsonify({
                "success": True,
                "duration": elapsed,
                "compiled_doc": compile_doc,
                "pdf_url": f"/api/projects/{project_id}/pdf?doc={urllib.parse.quote(compile_doc)}&t={int(time.time() * 1000)}",
                "log": res.stdout or "编译成功",
                "diagnostics": diagnostics
            })
        else:
            errors = parse_tectonic_errors(res.stderr or res.stdout)
            full_log = (res.stdout or "") + "\n" + (res.stderr or "")
            diagnostics = analyze_compile_diagnostics(full_log, tex_path)
            return jsonify({
                "success": False,
                "duration": elapsed,
                "compiled_doc": compile_doc,
                "errors": errors,
                "log": res.stderr or res.stdout,
                "diagnostics": diagnostics
            })
    except subprocess.TimeoutExpired:
        return jsonify({
            "success": False,
            "duration": 120,
            "errors": [{"line": 1, "message": "编译超时（超过120秒）"}],
            "log": "Compilation timed out after 120 seconds."
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "duration": 0,
            "errors": [{"line": 1, "message": str(e)}],
            "log": str(e)
        })

@app.route("/api/projects/<project_id>/synctex/forward", methods=["GET"])
def synctex_forward(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    file_name = request.args.get("file")
    if not file_name:
        file_name = get_project_root_document(project_id)
    else:
        file_name = file_name.strip().lstrip("/\\")
    try:
        line_no = int(request.args.get("line", 1))
    except (ValueError, TypeError):
        line_no = 1
    doc = request.args.get("doc", "").strip().lstrip("/\\")
    pos = find_pos_for_line(p_dir, file_name, line_no, doc=doc or file_name)
    return jsonify({
        "success": True,
        "page": pos["page"],
        "x": pos["x"],
        "y": pos["y"],
        "w": pos["w"],
        "h": pos["h"],
        "file": file_name,
        "line": line_no
    })

@app.route("/api/projects/<project_id>/synctex/backward", methods=["GET"])
def synctex_backward(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    try:
        page = int(request.args.get("page", 1))
        x = float(request.args.get("x", 0.0))
        y = float(request.args.get("y", 0.0))
    except (ValueError, TypeError):
        page, x, y = 1, 0.0, 0.0
    doc = request.args.get("doc", "").strip().lstrip("/\\")
    match = find_line_for_pos(p_dir, page, x, y, doc=doc)
    return jsonify({
        "success": True,
        "file": match["file"],
        "line": match["line"]
    })

@app.route("/api/projects/<project_id>/pdf", methods=["GET"])
def get_pdf(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    build_dir = os.path.join(p_dir, "build")
    if not os.path.exists(build_dir):
        return "PDF not found", 404
        
    doc = request.args.get("doc", "").strip().lstrip("/\\")
    if doc:
        doc_stem = os.path.splitext(os.path.basename(doc))[0]
        pdf_path = os.path.join(build_dir, f"{doc_stem}.pdf")
        if os.path.exists(pdf_path):
            return send_file(pdf_path, mimetype="application/pdf", as_attachment=False)

    root_doc = get_project_root_document(project_id)
    doc_stem = os.path.splitext(os.path.basename(root_doc))[0]
    pdf_path = os.path.join(build_dir, f"{doc_stem}.pdf")
    if not os.path.exists(pdf_path):
        candidates = [os.path.join(build_dir, f) for f in os.listdir(build_dir) if f.lower().endswith(".pdf")]
        if candidates:
            candidates.sort(key=lambda x: os.path.getmtime(x), reverse=True)
            pdf_path = candidates[0]
        else:
            return "PDF not found", 404
    return send_file(pdf_path, mimetype="application/pdf", as_attachment=False)

@app.route("/viewer")
def popout_viewer():
    return send_from_directory("static", "viewer.html")

@app.route("/api/projects/<project_id>/citations", methods=["GET"])
def get_project_citations(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "citations": []}), 404
        
    citations = []
    seen_keys = set()
    for root, dirs, files in os.walk(p_dir):
        if "build" in root or ".history" in root:
            continue
        for file in files:
            if file.lower().endswith(".bib"):
                bib_path = os.path.join(root, file)
                try:
                    with open(bib_path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                    entries = re.findall(r'@([a-zA-Z]+)\s*\{\s*([a-zA-Z0-9_\-:\.]+)\s*,([\s\S]*?)(?=\n@|\Z)', content)
                    for entry_type, key, body in entries:
                        key = key.strip()
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                        
                        title_m = re.search(r'title\s*=\s*[\{\"]([^\"\}]+)[\}\"]', body, re.IGNORECASE)
                        author_m = re.search(r'author\s*=\s*[\{\"]([^\"\}]+)[\}\"]', body, re.IGNORECASE)
                        year_m = re.search(r'year\s*=\s*[\{\"]?(\d{4})[\}\"]?', body, re.IGNORECASE)
                        
                        citations.append({
                            "key": key,
                            "type": entry_type.lower(),
                            "title": title_m.group(1).strip() if title_m else "",
                            "author": author_m.group(1).strip() if author_m else "",
                            "year": year_m.group(1).strip() if year_m else "",
                            "file": os.path.relpath(bib_path, p_dir).replace("\\", "/")
                        })
                except Exception as e:
                    print(f"[WARN] Error reading bib file {bib_path}: {e}")
                    
    return jsonify({"success": True, "citations": citations})

@app.route("/api/projects/<project_id>/labels", methods=["GET"])
def get_project_labels(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "labels": []}), 404
        
    labels = []
    seen_keys = set()
    for root, dirs, files in os.walk(p_dir):
        if "build" in root or ".history" in root:
            continue
        for file in files:
            if file.lower().endswith(".tex"):
                tex_path = os.path.join(root, file)
                rel_file = os.path.relpath(tex_path, p_dir).replace("\\", "/")
                try:
                    with open(tex_path, "r", encoding="utf-8", errors="ignore") as f:
                        for line_idx, line in enumerate(f, 1):
                            code_part = line.split('%')[0]
                            label_matches = re.findall(r'\\label\{([^}]+)\}', code_part)
                            for lbl in label_matches:
                                lbl = lbl.strip()
                                if lbl in seen_keys:
                                    continue
                                seen_keys.add(lbl)
                                
                                lbl_lower = lbl.lower()
                                if lbl_lower.startswith("fig:") or lbl_lower.startswith("figure:"):
                                    lbl_type, icon = "插图 (Figure)", "🖼️"
                                elif lbl_lower.startswith("tab:") or lbl_lower.startswith("table:"):
                                    lbl_type, icon = "表格 (Table)", "📊"
                                elif lbl_lower.startswith("sec:") or lbl_lower.startswith("section:"):
                                    lbl_type, icon = "章节 (Section)", "📑"
                                elif lbl_lower.startswith("eq:") or lbl_lower.startswith("equation:"):
                                    lbl_type, icon = "公式 (Equation)", "🔢"
                                else:
                                    lbl_type, icon = "自定义标签", "🏷️"
                                    
                                labels.append({
                                    "key": lbl,
                                    "file": rel_file,
                                    "line": line_idx,
                                    "type": lbl_type,
                                    "icon": icon
                                })
                except Exception as e:
                    print(f"[WARN] Error reading tex file {tex_path}: {e}")
                    
    return jsonify({"success": True, "labels": labels})

# --- Local History & Snapshot Manager ---
def get_project_history_dir(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    h_dir = os.path.join(p_dir, ".history")
    os.makedirs(h_dir, exist_ok=True)
    return h_dir

def get_project_history_settings(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    meta_path = os.path.join(p_dir, "meta.json")
    default_settings = {
        "auto_clean_enabled": True,
        "mode": "keep_recent_count",
        "days": 2,
        "count": 20
    }
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
            if "history_settings" in meta and isinstance(meta["history_settings"], dict):
                default_settings.update(meta["history_settings"])
        except Exception:
            pass
    return default_settings

def save_project_history_settings(project_id, settings):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    meta_path = os.path.join(p_dir, "meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
            if "history_settings" not in meta:
                meta["history_settings"] = {}
            meta["history_settings"].update(settings)
            with open(meta_path, "w", encoding="utf-8") as mf:
                json.dump(meta, mf, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            print("[WARN] Error saving history settings:", e)
    return False

def apply_history_retention(project_id):
    """Automatically cleans up unstarred snapshots according to project history settings."""
    settings = get_project_history_settings(project_id)
    if not settings.get("auto_clean_enabled", True):
        return 0

    h_dir = get_project_history_dir(project_id)
    if not os.path.exists(h_dir):
        return 0

    snapshots = []
    for d in os.listdir(h_dir):
        m_path = os.path.join(h_dir, d, "manifest.json")
        if os.path.exists(m_path):
            try:
                with open(m_path, "r", encoding="utf-8") as mf:
                    manifest = json.load(mf)
                snapshots.append((d, manifest))
            except Exception:
                pass

    snapshots.sort(key=lambda x: x[1].get("timestamp", 0), reverse=True)
    mode = settings.get("mode", "keep_recent_count")
    try:
        days = float(settings.get("days", 2))
    except (ValueError, TypeError):
        days = 2.0
    try:
        count = int(settings.get("count", 20))
    except (ValueError, TypeError):
        count = 20
    now = time.time()
    deleted_count = 0

    if mode == "older_than_days":
        cutoff = now - (days * 86400)
        for d, m in snapshots:
            if not m.get("starred", False) and m.get("timestamp", 0) < cutoff:
                shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
                deleted_count += 1
    elif mode == "keep_recent_count":
        unstarred_seen = 0
        for d, m in snapshots:
            if not m.get("starred", False):
                unstarred_seen += 1
                if unstarred_seen > count:
                    shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
                    deleted_count += 1

    return deleted_count

def create_project_snapshot(project_id, comment="自动保存快照", starred=False):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return None
        
    h_dir = get_project_history_dir(project_id)
    snap_id = f"snap_{int(time.time() * 1000)}"
    snap_dir = os.path.join(h_dir, snap_id)
    os.makedirs(snap_dir, exist_ok=True)
    
    saved_files = []
    TEXT_EXTS = {".tex", ".bib", ".sty", ".cls", ".txt", ".md", ".json"}
    for root, dirs, files in os.walk(p_dir):
        rel_root = os.path.relpath(root, p_dir)
        if rel_root == "build" or rel_root.startswith("build" + os.sep):
            continue
        if rel_root == ".history" or rel_root.startswith(".history" + os.sep):
            continue
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in TEXT_EXTS:
                src_path = os.path.join(root, f)
                rel_path = os.path.relpath(src_path, p_dir)
                dest_path = os.path.join(snap_dir, rel_path)
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                shutil.copy2(src_path, dest_path)
                saved_files.append(rel_path.replace("\\", "/"))
                
    manifest = {
        "id": snap_id,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": time.time(),
        "starred": bool(starred),
        "comment": comment,
        "root_document": get_project_root_document(project_id),
        "files": saved_files
    }
    with open(os.path.join(snap_dir, "manifest.json"), "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, ensure_ascii=False, indent=2)

    try:
        apply_history_retention(project_id)
    except Exception as re:
        print("[WARN] Auto retention error:", re)
        
    return manifest

@app.route("/api/projects/<project_id>/history", methods=["GET"])
def list_project_history(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(p_dir):
        return jsonify({"success": False, "snapshots": []}), 404
        
    h_dir = get_project_history_dir(project_id)
    snapshots = []
    total_bytes = 0
    if os.path.exists(h_dir):
        for d in os.listdir(h_dir):
            m_path = os.path.join(h_dir, d, "manifest.json")
            if os.path.exists(m_path):
                try:
                    with open(m_path, "r", encoding="utf-8") as mf:
                        manifest = json.load(mf)
                    snapshots.append(manifest)
                except Exception:
                    pass
        for root, _, files in os.walk(h_dir):
            for f in files:
                try:
                    total_bytes += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass

    snapshots.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    return jsonify({
        "success": True,
        "snapshots": snapshots,
        "total_size_kb": round(total_bytes / 1024, 1),
        "settings": get_project_history_settings(project_id)
    })

@app.route("/api/projects/<project_id>/history/settings", methods=["GET", "POST"])
def project_history_settings_route(project_id):
    if request.method == "POST":
        data = request.json or {}
        save_project_history_settings(project_id, data)
        apply_history_retention(project_id)
    settings = get_project_history_settings(project_id)
    h_dir = get_project_history_dir(project_id)
    total_bytes = 0
    total_count = 0
    if os.path.exists(h_dir):
        for d in os.listdir(h_dir):
            m_path = os.path.join(h_dir, d, "manifest.json")
            if os.path.exists(m_path):
                total_count += 1
        for root, _, files in os.walk(h_dir):
            for f in files:
                try:
                    total_bytes += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass
    return jsonify({
        "success": True,
        "settings": settings,
        "total_count": total_count,
        "total_size_kb": round(total_bytes / 1024, 1)
    })

@app.route("/api/projects/<project_id>/history/snapshot", methods=["POST"])
def manual_project_snapshot(project_id):
    data = request.json or {}
    comment = data.get("comment", "").strip() or "手动保存快照"
    starred = data.get("starred", False)
    manifest = create_project_snapshot(project_id, comment=comment, starred=starred)
    if manifest:
        return jsonify({"success": True, "snapshot": manifest})
    return jsonify({"success": False, "error": "创建快照失败"}), 500

@app.route("/api/projects/<project_id>/history/<snapshot_id>/star", methods=["POST"])
def toggle_snapshot_star(project_id, snapshot_id):
    h_dir = get_project_history_dir(project_id)
    m_path = os.path.join(h_dir, snapshot_id, "manifest.json")
    if not os.path.exists(m_path):
        return jsonify({"success": False, "error": "快照不存在"}), 404
    try:
        with open(m_path, "r", encoding="utf-8") as mf:
            manifest = json.load(mf)
        manifest["starred"] = not manifest.get("starred", False)
        with open(m_path, "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "starred": manifest["starred"]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/projects/<project_id>/history/<snapshot_id>/delete", methods=["DELETE", "POST"])
def delete_single_snapshot(project_id, snapshot_id):
    h_dir = get_project_history_dir(project_id)
    snap_dir = os.path.join(h_dir, snapshot_id)
    if os.path.exists(snap_dir):
        shutil.rmtree(snap_dir, ignore_errors=True)
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "快照不存在"}), 404

@app.route("/api/projects/<project_id>/history/<snapshot_id>/content", methods=["GET"])
def get_snapshot_content(project_id, snapshot_id):
    h_dir = get_project_history_dir(project_id)
    rel_path = request.args.get("path", "").strip().lstrip("/\\")
    snap_dir = os.path.join(h_dir, snapshot_id)
    if not os.path.exists(snap_dir):
        return jsonify({"error": "快照不存在"}), 404
        
    if not rel_path:
        m_path = os.path.join(snap_dir, "manifest.json")
        if os.path.exists(m_path):
            with open(m_path, "r", encoding="utf-8") as mf:
                rel_path = json.load(mf).get("root_document", "main.tex")
        else:
            rel_path = "main.tex"
            
    target = os.path.join(snap_dir, rel_path)
    if not os.path.exists(target):
        return jsonify({"success": True, "content": "", "path": rel_path, "exists": False})
        
    try:
        with open(target, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        return jsonify({"success": True, "content": content, "path": rel_path, "exists": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/projects/<project_id>/history/<snapshot_id>/restore", methods=["POST"])
def restore_project_snapshot(project_id, snapshot_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    h_dir = get_project_history_dir(project_id)
    snap_dir = os.path.join(h_dir, snapshot_id)
    if not os.path.exists(snap_dir):
        return jsonify({"success": False, "error": "指定历史快照不存在"}), 404
        
    create_project_snapshot(project_id, comment="还原前自动备份", starred=False)
    
    restored = []
    for root, dirs, files in os.walk(snap_dir):
        rel = os.path.relpath(root, snap_dir)
        for f in files:
            if f == "manifest.json":
                continue
            src_f = os.path.join(root, f)
            dest_f = os.path.join(p_dir, rel, f) if rel != "." else os.path.join(p_dir, f)
            os.makedirs(os.path.dirname(dest_f), exist_ok=True)
            shutil.copy2(src_f, dest_f)
            restored.append(os.path.relpath(dest_f, p_dir).replace("\\", "/"))
            
    return jsonify({"success": True, "restored_files": restored})

@app.route("/api/projects/<project_id>/history/clean", methods=["POST"])
def clean_project_history(project_id):
    h_dir = get_project_history_dir(project_id)
    if not os.path.exists(h_dir):
        return jsonify({"success": True, "deleted_count": 0, "remaining_count": 0})
        
    data = request.json or {}
    policy = data.get("policy", "older_than_days")
    try:
        days = float(data.get("days", 2))
    except (ValueError, TypeError):
        days = 2.0
    try:
        count = int(data.get("count", 10))
    except (ValueError, TypeError):
        count = 10
    
    snapshots = []
    for d in os.listdir(h_dir):
        m_path = os.path.join(h_dir, d, "manifest.json")
        if os.path.exists(m_path):
            try:
                with open(m_path, "r", encoding="utf-8") as mf:
                    manifest = json.load(mf)
                snapshots.append((d, manifest))
            except Exception:
                pass
                
    snapshots.sort(key=lambda x: x[1].get("timestamp", 0), reverse=True)
    deleted_count = 0
    now = time.time()
    
    if policy == "clean_everything":
        for d, _ in snapshots:
            shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
            deleted_count += 1
    elif policy == "clean_all_unstarred":
        for d, m in snapshots:
            if not m.get("starred", False):
                shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
                deleted_count += 1
    elif policy == "older_than_days":
        cutoff = now - (days * 86400)
        for d, m in snapshots:
            if not m.get("starred", False) and m.get("timestamp", 0) < cutoff:
                shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
                deleted_count += 1
    elif policy == "keep_recent_count":
        unstarred_seen = 0
        for d, m in snapshots:
            if not m.get("starred", False):
                unstarred_seen += 1
                if unstarred_seen > count:
                    shutil.rmtree(os.path.join(h_dir, d), ignore_errors=True)
                    deleted_count += 1
                    
    remaining = len(os.listdir(h_dir)) if os.path.exists(h_dir) else 0
    return jsonify({
        "success": True,
        "deleted_count": deleted_count,
        "remaining_count": remaining
    })

@app.route("/api/system/info", methods=["GET"])
def system_info():
    cache_size_bytes = 0
    include_size = request.args.get("include_size", "0") == "1"
    if include_size and os.path.exists(CACHE_DIR):
        for root, dirs, files in os.walk(CACHE_DIR):
            for f in files:
                cache_size_bytes += os.path.getsize(os.path.join(root, f))
    
    return jsonify({
        "cache_dir": CACHE_DIR,
        "cache_size_mb": round(cache_size_bytes / 1024 / 1024, 2) if include_size else None,
        "projects_dir": PROJECTS_DIR,
        "tectonic_path": TECTONIC_EXE
    })

@app.route("/api/system/fonts", methods=["GET"])
def get_system_fonts():
    has_fandol = os.path.exists(FANDOL_DIR) and os.path.exists(os.path.join(FANDOL_DIR, "FandolSong-Regular.otf"))
    bundled = [
        {
            "name": "Fandol 官方字体族",
            "family": "Fandol",
            "desc": "包含宋体、黑体、楷体、仿宋 (1:1 对齐 Overleaf)",
            "status": "已就绪",
            "is_default": True
        },
        {
            "name": "Windows 系统中易字体族",
            "family": "SimSun / SimHei",
            "desc": "包含中易宋体、黑体、楷体、仿宋、微软雅黑",
            "status": "已就绪",
            "is_default": False
        }
    ]

    installed_fonts = []
    seen = set()
    CHINESE_KEYWORDS = [
        'simsun', 'simhei', 'msyh', 'yahei', 'kaiti', 'fangsong', 'dengxian',
        'songti', 'heiti', 'ming', 'kai', 'fang', 'lisu', 'youyuan',
        'source han', 'noto sans sc', 'noto serif sc', 'fandol', 'pingfang',
        'fz', '方正', '汉仪', '华文', '文泉驿'
    ]

    if sys.platform == "win32":
        try:
            import winreg
            keys = [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
                (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Fonts")
            ]
            for hkey, subkey in keys:
                try:
                    with winreg.OpenKey(hkey, subkey) as key:
                        num = winreg.QueryInfoKey(key)[1]
                        for i in range(num):
                            name, val, _ = winreg.EnumValue(key, i)
                            name_low = name.lower()
                            val_low = val.lower()
                            if any(kw in name_low or kw in val_low for kw in CHINESE_KEYWORDS):
                                clean_name = name.split('(')[0].strip()
                                if clean_name not in seen:
                                    seen.add(clean_name)
                                    installed_fonts.append({
                                        "name": clean_name,
                                        "file": val,
                                        "status": "已就绪"
                                    })
                except Exception:
                    pass
        except Exception:
            pass

    return jsonify({
        "success": True,
        "has_fandol": has_fandol,
        "bundled": bundled,
        "installed_count": len(installed_fonts),
        "installed": sorted(installed_fonts, key=lambda x: x["name"])
    })

def launch_edge_app():
    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ]
    edge_exe = None
    for ep in edge_paths:
        if os.path.exists(ep):
            edge_exe = ep
            break

    profile_dir = os.path.join(DATA_DIR, "edge_profile")
    url = "http://127.0.0.1:5820"

    import socket
    attempts = 0
    for attempts in range(120):
        try:
            s = socket.socket()
            s.settimeout(0.05)
            s.connect(("127.0.0.1", 5820))
            s.close()
            break
        except Exception:
            time.sleep(0.015)

    log_msg(f"[EDGE] Server port ready after {attempts} checks. Spawning Edge window...")

    # Permanently turn off Edge Mini Menu / Quick Action popups when selecting text
    try:
        pref_dir = os.path.join(profile_dir, "Default")
        os.makedirs(pref_dir, exist_ok=True)
        pref_file = os.path.join(pref_dir, "Preferences")
        prefs = {}
        if os.path.exists(pref_file):
            with open(pref_file, "r", encoding="utf-8") as pf:
                prefs = json.load(pf)
        prefs["edge_quick_search"] = {
            "PDF_show_mini_menu": False,
            "PDF_show_smart_actions_full_menu": False,
            "PDF_show_smart_actions_mini_menu": False,
            "customized_disabled_sites": [],
            "default_removed_sites": [],
            "show_inlined_smart_card": False,
            "show_inspect_tool": False,
            "show_mini_menu": False,
            "show_smart_actions": False,
            "show_smart_actions_in_full_menu": False,
            "smart_action_block_list": []
        }
        # Suppress Microsoft Edge Copilot rewrite, inline write assistance & hover pencil button
        prefs["compose_inline_enabled"] = False
        prefs["edge_compose"] = {"enabled": False}
        prefs["edge_writing_assistance"] = {"enabled": False}
        if "edge" not in prefs:
            prefs["edge"] = {}
        prefs["edge"]["compose_copilot_consent_accepted"] = False
        prefs["edge"]["compose_inline_enabled"] = False
        with open(pref_file, "w", encoding="utf-8") as pf:
            json.dump(prefs, pf)
    except Exception as pe:
        log_msg(f"[EDGE] Error configuring mini-menu preferences: {pe}")

    flags = subprocess.DETACHED_PROCESS if sys.platform == "win32" else 0
    if edge_exe:
        cmd = [
            edge_exe,
            f"--app={url}",
            f"--user-data-dir={profile_dir}",
            "--window-size=1280,820",
            "--no-proxy-server",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-component-update",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-domain-reliability",
            "--disable-metrics",
            "--disable-metrics-reporting",
            "--disk-cache-size=10485760",
            "--media-cache-size=10485760",
            "--disable-features=msWebOOUI,msPdfOOUI,EdgeMiniMenu,msEdgeMiniMenu,Translate,EdgeEntityExtraction,EdgeVisualSearch,EdgeSmartScreen,EdgeCollections,EdgeShopping,ComposeInline,EdgeCompose,msEdgeWritingAssistance,EdgeWritingAssistance,msEdgeInlineRewrite,EdgeInlineRewrite"
        ]
        log_msg(f"[EDGE] Running cmd: {cmd}")
        subprocess.Popen(cmd, creationflags=flags)
    else:
        log_msg("[EDGE] Edge not found, opening default browser.")
        import webbrowser
        webbrowser.open(url)

if __name__ == "__main__":
    log_msg("[STARTUP] Python process starting __main__")
    ensure_initial_projects()
    port = 5820

    # If already running, launch window to existing server and exit
    import socket
    is_already_running = False
    try:
        s = socket.socket()
        s.settimeout(0.3)
        s.connect(("127.0.0.1", port))
        s.close()
        is_already_running = True
    except Exception:
        pass

    log_msg(f"[STARTUP] is_already_running={is_already_running}")

    if is_already_running:
        launch_edge_app()
        log_msg("[STARTUP] Secondary process exiting cleanly after requesting window focus.")
        sys.exit(0)

    # Server starting fresh: clean any dead Edge orphans asynchronously so it never blocks Flask startup
    threading.Thread(target=cleanup_zombie_edge, daemon=True).start()

    # Launch Edge browser as soon as server socket is ready
    threading.Thread(target=launch_edge_app, daemon=True).start()

    log_msg(f"[STARTUP] Starting Flask app on port {port}")
    try:
        app.run(host="127.0.0.1", port=port, debug=False)
    except Exception as e:
        log_msg(f"[FATAL] app.run crashed: {e}")
        raise

