import os
import sys
import time
import json
import shutil
import re
import subprocess
import threading
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
        file_line_match = re.search(r'[\w\-.]+\.tex:(\d+):', line)
        colon_line_match = re.search(r':(\d+):', line)
        line_match = re.search(r'line\s+(\d+)', line, re.IGNORECASE)
        l_num_match = re.search(r'^l\.(\d+)', line)
        if "error:" in line.lower() or line.startswith("!"):
            line_no = None
            if file_line_match:
                line_no = int(file_line_match.group(1))
            elif colon_line_match:
                line_no = int(colon_line_match.group(1))
            elif line_match:
                line_no = int(line_match.group(1))
            elif l_num_match:
                line_no = int(l_num_match.group(1))
            elif i + 1 < len(lines):
                next_line = lines[i+1]
                next_match = (re.search(r'[\w\-.]+\.tex:(\d+):', next_line) or 
                              re.search(r':(\d+):', next_line) or
                              re.search(r'line\s+(\d+)', next_line, re.IGNORECASE) or 
                              re.search(r'^l\.(\d+)', next_line))
                if next_match:
                    line_no = int(next_match.group(1))
            errors.append({
                "line": line_no or 1,
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

def ensure_ctex_windows_font_shim(project_dir):
    """
    Ensure Overleaf CTeX documents (which default to fontset=fandol) seamlessly 
    render using bundled Fandol fonts (1:1 identical to Overleaf) or gracefully
    fallback to Windows system fonts (SimSun, SimHei) if Fandol is missing.
    """
    if not os.path.exists(project_dir):
        return

    fandol_fonts = [
        "FandolSong-Regular.otf", "FandolSong-Bold.otf",
        "FandolHei-Regular.otf", "FandolHei-Bold.otf",
        "FandolKai-Regular.otf", "FandolFang-Regular.otf"
    ]
    has_fandol = os.path.exists(FANDOL_DIR) and any(
        os.path.exists(os.path.join(FANDOL_DIR, f)) for f in fandol_fonts
    )

    shim_path = os.path.join(project_dir, "ctex-fontset-fandol.def")

    if has_fandol:
        for f in fandol_fonts:
            src = os.path.join(FANDOL_DIR, f)
            dst = os.path.join(project_dir, f)
            if os.path.exists(src) and not os.path.exists(dst):
                try:
                    os.link(src, dst)
                except Exception:
                    try:
                        shutil.copy2(src, dst)
                    except Exception as ce:
                        print(f"[WARN] Failed to link/copy font {f}:", ce)

        fandol_def_content = r"""%%
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
        try:
            with open(shim_path, "w", encoding="utf-8") as f:
                f.write(fandol_def_content)
        except Exception as e:
            print("[WARN] Failed to write ctex font shim:", e)
    else:
        try:
            with open(shim_path, "w", encoding="utf-8") as f:
                f.write("% Auto-generated by PaperLeaf for Overleaf Chinese font compatibility\n\\input{ctex-fontset-windows.def}\n")
        except Exception as e:
            print("[WARN] Failed to write fallback ctex font shim:", e)

def ensure_initial_projects():
    existing = [d for d in os.listdir(PROJECTS_DIR) if os.path.isdir(os.path.join(PROJECTS_DIR, d))]
    for d in existing:
        ensure_ctex_windows_font_shim(os.path.join(PROJECTS_DIR, d))
    if not existing:
        create_project_internal("demo_chinese", "中文学术论文示例", "chinese")
        create_project_internal("demo_english", "English Research Demo", "english")

def create_project_internal(project_id, name, language):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    os.makedirs(p_dir, exist_ok=True)
    ensure_ctex_windows_font_shim(p_dir)
    meta = {
        "id": project_id,
        "name": name,
        "language": language,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    with open(os.path.join(p_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    
    tex_content = TEMPLATES.get(language, TEMPLATES["english"])["content"]
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
        for p in psutil.process_iter(['name', 'cmdline']):
            try:
                name = (p.info.get('name') or '').lower()
                cmdline = ' '.join(p.info.get('cmdline') or [])
                if 'msedge' in name and 'edge_profile' in cmdline:
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
        
    files_list = []
    for root, dirs, files in os.walk(p_dir):
        rel_dir = os.path.relpath(root, p_dir)
        if rel_dir == "build" or rel_dir.startswith("build" + os.sep):
            continue
        for d in dirs:
            if d == "build":
                continue
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
            files_list.append({
                "name": f,
                "path": r_path,
                "is_dir": False,
                "ext": ext,
                "size": os.path.getsize(os.path.join(root, f))
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
    return jsonify({"files": files_list})

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
    
    if not rel_path or rel_path == "main.tex":
        return jsonify({"error": "不能删除 main.tex 核心文件"}), 400
        
    target_path = os.path.abspath(os.path.join(p_dir, rel_path))
    if not is_safe_subpath(p_dir, target_path):
        return jsonify({"error": "非法路径"}), 400
        
    if os.path.isdir(target_path):
        shutil.rmtree(target_path, ignore_errors=True)
    elif os.path.exists(target_path):
        os.remove(target_path)
        
    return jsonify({"success": True})

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
            pdf_path = os.path.join(p_dir, "build", "main.pdf")
            meta["has_pdf"] = os.path.exists(pdf_path)
            projects.append(meta)
    projects.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return jsonify({"projects": projects})

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
                
        # Smart main.tex detection
        main_tex = os.path.join(p_dir, "main.tex")
        if not os.path.exists(main_tex):
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
                shutil.copyfile(best_file, main_tex)
            else:
                with open(main_tex, "w", encoding="utf-8") as f_out:
                    f_out.write(TEMPLATES["chinese"]["content"])
        
        # Detect language
        is_chinese = False
        try:
            with open(main_tex, "r", encoding="utf-8", errors="ignore") as f_tex:
                first_part = f_tex.read(4000)
                if "ctex" in first_part.lower() or any('\u4e00' <= char <= '\u9fff' for char in first_part):
                    is_chinese = True
        except Exception:
            pass
            
        meta = {
            "id": project_id,
            "name": clean_name,
            "language": "chinese" if is_chinese else "english",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "has_pdf": False
        }
        with open(os.path.join(p_dir, "meta.json"), "w", encoding="utf-8") as mf:
            json.dump(meta, mf, ensure_ascii=False, indent=2)
            
        ensure_ctex_windows_font_shim(p_dir)
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
            for file in files:
                if file.endswith(".zip") or file.startswith("_temp") or file == "ctex-fontset-fandol.def" or (file.startswith("Fandol") and file.endswith(".otf")):
                    continue
                if is_clean:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in JUNK_EXTS:
                        continue
                full_path = os.path.join(root, file)
                arcname = os.path.relpath(full_path, p_dir)
                zip_out.write(full_path, arcname)
                
    memory_zip.seek(0)
    dl_name = f"{proj_name}{suffix}.zip"
    return send_file(memory_zip, mimetype="application/zip", as_attachment=True, download_name=dl_name)

@app.route("/api/projects", methods=["POST"])
def create_project():
    data = request.json or {}
    name = data.get("name", "").strip() or "未命名项目"
    language = data.get("language", "chinese")
    project_id = f"project_{int(time.time())}"
    meta = create_project_internal(project_id, name, language)
    return jsonify({"success": True, "project": meta})

@app.route("/api/projects/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    p_dir = os.path.join(PROJECTS_DIR, project_id)
    if os.path.exists(p_dir):
        shutil.rmtree(p_dir, ignore_errors=True)
        return jsonify({"success": True, "message": f"项目 {project_id} 及其所有生成文件已彻底清理"})
    return jsonify({"success": False, "message": "项目不存在"}), 404

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
    tex_path = os.path.join(p_dir, "main.tex")
    build_dir = os.path.join(p_dir, "build")
    os.makedirs(build_dir, exist_ok=True)
    
    data = request.get_json(silent=True) or {}
    if "content" in data and data["content"]:
        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(data["content"])

    if not os.path.exists(tex_path):
        return jsonify({"success": False, "error": "文件不存在"}), 400

    env = os.environ.copy()
    env["TECTONIC_CACHE_DIR"] = CACHE_DIR

    ensure_ctex_windows_font_shim(p_dir)
    try:
        preprocess_project_eps(p_dir)
    except Exception as epse:
        print("[WARN] EPS preprocessing error on compile:", epse)

    start_time = time.time()
    cmd = [TECTONIC_EXE, "--synctex", "--print", "-o", build_dir, tex_path]
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
        pdf_path = os.path.join(build_dir, "main.pdf")
        
        if res.returncode == 0 and os.path.exists(pdf_path):
            meta_file = os.path.join(p_dir, "meta.json")
            if os.path.exists(meta_file):
                try:
                    with open(meta_file, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                    meta["has_pdf"] = True
                    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    with open(meta_file, "w", encoding="utf-8") as mf:
                        json.dump(meta, mf, ensure_ascii=False, indent=2)
                except Exception:
                    pass

            full_log = (res.stdout or "") + "\n" + (res.stderr or "")
            diagnostics = analyze_compile_diagnostics(full_log, tex_path)

            return jsonify({
                "success": True,
                "duration": elapsed,
                "pdf_url": f"/api/projects/{project_id}/pdf?t={int(time.time() * 1000)}",
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
    file_name = request.args.get("file", "main.tex")
    try:
        line_no = int(request.args.get("line", 1))
    except (ValueError, TypeError):
        line_no = 1
    pos = find_pos_for_line(p_dir, file_name, line_no)
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
    match = find_line_for_pos(p_dir, page, x, y)
    return jsonify({
        "success": True,
        "file": match["file"],
        "line": match["line"]
    })

@app.route("/api/projects/<project_id>/pdf", methods=["GET"])
def get_pdf(project_id):
    pdf_path = os.path.join(PROJECTS_DIR, project_id, "build", "main.pdf")
    if not os.path.exists(pdf_path):
        return "PDF not found", 404
    return send_file(pdf_path, mimetype="application/pdf", as_attachment=False)

@app.route("/api/system/info", methods=["GET"])
def system_info():
    cache_size_bytes = 0
    if os.path.exists(CACHE_DIR):
        for root, dirs, files in os.walk(CACHE_DIR):
            for f in files:
                cache_size_bytes += os.path.getsize(os.path.join(root, f))
    
    return jsonify({
        "cache_dir": CACHE_DIR,
        "cache_size_mb": round(cache_size_bytes / 1024 / 1024, 2),
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
    for attempts in range(60):
        time.sleep(0.05)
        try:
            s = socket.socket()
            s.settimeout(0.1)
            s.connect(("127.0.0.1", 5820))
            s.close()
            break
        except Exception:
            pass

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
            "--disable-features=msWebOOUI,msPdfOOUI,EdgeMiniMenu,msEdgeMiniMenu,Translate,EdgeEntityExtraction,EdgeVisualSearch,EdgeSmartScreen,EdgeCollections,EdgeShopping"
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

    # Server starting fresh: clean any dead Edge orphans holding our profile
    cleanup_zombie_edge()

    # Launch Edge browser as soon as server socket is ready
    threading.Thread(target=launch_edge_app, daemon=True).start()

    log_msg(f"[STARTUP] Starting Flask app on port {port}")
    try:
        app.run(host="127.0.0.1", port=port, debug=False)
    except Exception as e:
        log_msg(f"[FATAL] app.run crashed: {e}")
        raise

