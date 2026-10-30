// PaperLeaf Core Client Logic - Polished & Optimized
let editor = null;
let currentProjectId = null;
let currentProjectMeta = null;
let isCompiling = false;
let autoCompileEnabled = true;
let compileDebounceTimer = null;
let saveDebounceTimer = null;
let currentViewMode = 'split'; // 'code', 'split', 'paper'
let splitRatio = 0.5; // Proportional split ratio between Code and PDF (Option A)
try {
  const savedRatio = parseFloat(localStorage.getItem('paperleaf_split_ratio') || localStorage.getItem('localoverleaf_split_ratio'));
  if (!isNaN(savedRatio) && savedRatio >= 0.15 && savedRatio <= 0.85) {
    splitRatio = savedRatio;
  }
} catch (e) {}

function applySplitRatio() {
  if (currentViewMode === 'split') {
    const leftWeight = Math.max(0.15, Math.min(0.85, splitRatio));
    const rightWeight = 1 - leftWeight;
    editorPane.style.flex = `${leftWeight} 1 0px`;
    pdfPane.style.flex = `${rightWeight} 1 0px`;
  }
}

// DOM Elements
const drawer = document.getElementById('drawer');
const drawerResizer = document.getElementById('drawer-resizer');
const splitResizer = document.getElementById('split-resizer');
const editorPane = document.getElementById('editor-pane');
const pdfPane = document.getElementById('pdf-pane');
const pdfContainer = document.getElementById('pdf-container');
const pdfPlaceholder = document.getElementById('pdf-placeholder');
const compileStatus = document.getElementById('compile-status');

// PDF.js State & Initialization
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.js';
}

function createPdfLoadingTask(targetUrl) {
  return pdfjsLib.getDocument({
    url: targetUrl,
    cMapUrl: '/static/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/static/vendor/pdfjs/standard_fonts/',
  });
}
let currentPdfDoc = null;
let currentPdfUrl = null;
let pdfScale = 1.0;
let isFitWidth = true;
let isRenderingPdf = false;
let pdfRenderTasks = [];
const toggleAutoCompile = document.getElementById('toggle-autocompile');
const saveIndicator = document.getElementById('save-indicator');
let isSwitchingFile = false;

function setSaveStatus(state, timeStr) {
  if (!saveIndicator) return;
  const now = timeStr || (new Date().toTimeString().split(' ')[0]);
  if (state === 'saving') {
    saveIndicator.textContent = '🟡 正在保存...';
    saveIndicator.style.color = '#f59e0b';
    saveIndicator.title = '正在保存至本地磁盘...';
  } else if (state === 'saved') {
    saveIndicator.textContent = '🟢 已保存';
    saveIndicator.style.color = '#10b981';
    saveIndicator.title = `所有更改已实时保存于 ${now}`;
  } else if (state === 'error') {
    saveIndicator.textContent = '❌ 保存异常';
    saveIndicator.style.color = '#ef4444';
    saveIndicator.title = '自动保存失败，请检查网络或后端状态';
  }
}
const errorPanel = document.getElementById('error-panel');
const errorList = document.getElementById('error-list');
const errorTitle = document.getElementById('error-title');
const projectsList = document.getElementById('projects-list');

// --- 1. Heartbeat to keep backend alive & auto-close backend when tab closes ---
function startHeartbeat() {
  const send = () => {
    fetch('/api/system/heartbeat', { method: 'POST' }).catch(() => {});
  };
  send();
  setInterval(send, 3000);
  window.addEventListener('focus', send);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) send();
  });
}

// Helper: Universal Safe HTML Escaper
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m] || m));
}

// Helper: Check if a file path is safe for text editing/saving
function isEditableFile(filePath) {
  if (!filePath) return false;
  const parts = filePath.split('.');
  if (parts.length <= 1) return false;
  const ext = parts.pop().toLowerCase();
  const NON_EDITABLE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'pdf', 'eps', 'ps', 'ai', 'zip', 'tar', 'gz', '7z', 'rar', 'exe', 'dll', 'so', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'ico'];
  if (NON_EDITABLE_EXTS.includes(ext)) return false;
  return ['tex', 'bib', 'cls', 'sty', 'txt', 'md', 'json', 'bbl', 'aux', 'log', 'cfg', 'def'].includes(ext);
}

// Flush save on window unload & notify backend
window.addEventListener('beforeunload', () => {
  if (currentProjectId && editor && isEditableFile(currentActiveFile)) {
    try {
      const content = editor.getValue();
      localStorage.setItem(`draft_${currentProjectId}_${currentActiveFile}`, content);
      const blob = new Blob([JSON.stringify({ content, path: currentActiveFile })], { type: 'application/json' });
      navigator.sendBeacon(`/api/projects/${currentProjectId}/content`, blob);
    } catch (e) {}
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/system/window_closing');
  }
});

// --- 2. LaTeX Smart Autocomplete Dictionary & Helper ---
const LATEX_COMPLETIONS = [
  // Sectioning
  { text: "\\section{}", displayText: "\\section{...}", desc: "章节", cursorOffset: 9 },
  { text: "\\subsection{}", displayText: "\\subsection{...}", desc: "子章节", cursorOffset: 12 },
  { text: "\\subsubsection{}", displayText: "\\subsubsection{...}", desc: "三级章节", cursorOffset: 15 },
  { text: "\\paragraph{}", displayText: "\\paragraph{...}", desc: "段落", cursorOffset: 11 },
  { text: "\\chapter{}", displayText: "\\chapter{...}", desc: "主章", cursorOffset: 9 },

  // Environments
  { 
    text: "\\begin{equation}\n  \n\\end{equation}", 
    displayText: "\\begin{equation} ... \\end{equation}", 
    desc: "单行编号公式",
    cursorOffset: 19
  },
  { 
    text: "\\begin{align}\n  \n\\end{align}", 
    displayText: "\\begin{align} ... \\end{align}", 
    desc: "多行对齐公式",
    cursorOffset: 16
  },
  { 
    text: "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}", 
    displayText: "\\begin{figure} ... \\end{figure}", 
    desc: "标准插图",
    cursorOffset: 65
  },
  { 
    text: "\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{|c|c|}\n    \\hline\n     &  \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}", 
    displayText: "\\begin{table} ... \\end{table}", 
    desc: "标准表格",
    cursorOffset: 34
  },
  { 
    text: "\\begin{itemize}\n  \\item \n\\end{itemize}", 
    displayText: "\\begin{itemize} ... \\end{itemize}", 
    desc: "无序列表",
    cursorOffset: 26
  },
  { 
    text: "\\begin{enumerate}\n  \\item \n\\end{enumerate}", 
    displayText: "\\begin{enumerate} ... \\end{enumerate}", 
    desc: "有序列表",
    cursorOffset: 28
  },
  { 
    text: "\\begin{abstract}\n  \n\\end{abstract}", 
    displayText: "\\begin{abstract} ... \\end{abstract}", 
    desc: "摘要环境",
    cursorOffset: 19
  },
  { 
    text: "\\begin{proof}\n  \n\\end{proof}", 
    displayText: "\\begin{proof} ... \\end{proof}", 
    desc: "证明环境",
    cursorOffset: 16
  },

  // Common commands
  { text: "\\textbf{}", displayText: "\\textbf{...}", desc: "加粗", cursorOffset: 8 },
  { text: "\\textit{}", displayText: "\\textit{...}", desc: "斜体", cursorOffset: 8 },
  { text: "\\underline{}", displayText: "\\underline{...}", desc: "下划线", cursorOffset: 11 },
  { text: "\\emph{}", displayText: "\\emph{...}", desc: "强调", cursorOffset: 6 },
  { text: "\\cite{}", displayText: "\\cite{...}", desc: "引用文献", cursorOffset: 6 },
  { text: "\\ref{}", displayText: "\\ref{...}", desc: "引用标签", cursorOffset: 5 },
  { text: "\\label{}", displayText: "\\label{...}", desc: "定义标签", cursorOffset: 7 },
  { text: "\\usepackage{}", displayText: "\\usepackage{...}", desc: "引入宏包", cursorOffset: 12 },
  { text: "\\documentclass{}", displayText: "\\documentclass{...}", desc: "文档类", cursorOffset: 15 },
  { text: "\\title{}", displayText: "\\title{...}", desc: "论文标题", cursorOffset: 7 },
  { text: "\\author{}", displayText: "\\author{...}", desc: "作者", cursorOffset: 8 },
  { text: "\\date{\\today}", displayText: "\\date{\\today}", desc: "当前日期" },
  { text: "\\maketitle", displayText: "\\maketitle", desc: "生成标题" },
  { text: "\\tableofcontents", displayText: "\\tableofcontents", desc: "生成目录" },
  { text: "\\newpage", displayText: "\\newpage", desc: "分页" },
  { text: "\\centering", displayText: "\\centering", desc: "居中对齐" },
  { text: "\\includegraphics[width=0.8\\textwidth]{}", displayText: "\\includegraphics{...}", desc: "插入图片", cursorOffset: 38 },

  // Math symbols & operations
  { text: "\\frac{}{}", displayText: "\\frac{num}{den}", desc: "分数", cursorOffset: 6 },
  { text: "\\sqrt{}", displayText: "\\sqrt{...}", desc: "开根号", cursorOffset: 6 },
  { text: "\\sum_{}^{}", displayText: "\\sum_{i=1}^{n}", desc: "求和", cursorOffset: 6 },
  { text: "\\int_{}^{}", displayText: "\\int_{a}^{b}", desc: "积分", cursorOffset: 6 },
  { text: "\\lim_{}", displayText: "\\lim_{x \\to 0}", desc: "极限", cursorOffset: 5 },
  { text: "\\alpha", displayText: "\\alpha (α)", desc: "希腊字母" },
  { text: "\\beta", displayText: "\\beta (β)", desc: "希腊字母" },
  { text: "\\gamma", displayText: "\\gamma (γ)", desc: "希腊字母" },
  { text: "\\delta", displayText: "\\delta (δ)", desc: "希腊字母" },
  { text: "\\epsilon", displayText: "\\epsilon (ε)", desc: "希腊字母" },
  { text: "\\theta", displayText: "\\theta (θ)", desc: "希腊字母" },
  { text: "\\lambda", displayText: "\\lambda (λ)", desc: "希腊字母" },
  { text: "\\mu", displayText: "\\mu (μ)", desc: "希腊字母" },
  { text: "\\pi", displayText: "\\pi (π)", desc: "希腊字母" },
  { text: "\\sigma", displayText: "\\sigma (σ)", desc: "希腊字母" },
  { text: "\\tau", displayText: "\\tau (τ)", desc: "希腊字母" },
  { text: "\\omega", displayText: "\\omega (ω)", desc: "希腊字母" },
  { text: "\\infty", displayText: "\\infty (∞)", desc: "无穷大" },
  { text: "\\times", displayText: "\\times (×)", desc: "乘号" },
  { text: "\\cdot", displayText: "\\cdot (·)", desc: "点乘" },
  { text: "\\leq", displayText: "\\leq (≤)", desc: "小于等于" },
  { text: "\\geq", displayText: "\\geq (≥)", desc: "大于等于" },
  { text: "\\neq", displayText: "\\neq (≠)", desc: "不等于" },
  { text: "\\approx", displayText: "\\approx (≈)", desc: "约等于" },
  { text: "\\in", displayText: "\\in (∈)", desc: "属于" }
];

function latexHint(cm) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
  
  let start = cur.ch;
  while (start > 0 && /[\w\\@]/.test(line.charAt(start - 1))) {
    start--;
  }
  const prefix = line.slice(start, cur.ch);
  if (!prefix || prefix.length < 1) return null;

  const matches = [];
  const lowerPrefix = prefix.toLowerCase();

  for (const item of LATEX_COMPLETIONS) {
    if (item.text.toLowerCase().startsWith(lowerPrefix) || (item.text.startsWith('\\') && item.text.slice(1).toLowerCase().startsWith(lowerPrefix))) {
      matches.push({
        text: item.text,
        displayText: item.displayText,
        desc: item.desc,
        cursorOffset: item.cursorOffset,
        render: function(element, self, data) {
          const wrapper = document.createElement('div');
          wrapper.className = 'cm-hint-row';
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'cm-hint-cmd';
          cmdSpan.textContent = data.displayText || data.text;
          const descSpan = document.createElement('span');
          descSpan.className = 'cm-hint-desc';
          descSpan.textContent = data.desc || '';
          wrapper.appendChild(cmdSpan);
          if (data.desc) wrapper.appendChild(descSpan);
          element.appendChild(wrapper);
        },
        hint: function(cm, self, data) {
          cm.replaceRange(data.text, self.from, self.to);
          if (data.cursorOffset) {
            const lines = data.text.slice(0, data.cursorOffset).split('\n');
            const targetLine = self.from.line + lines.length - 1;
            const targetCh = lines.length === 1 ? self.from.ch + lines[0].length : lines[lines.length - 1].length;
            cm.setCursor({ line: targetLine, ch: targetCh });
          }
        }
      });
    }
  }

  // Also include document words if not starting with \ and length >= 3
  if (!prefix.startsWith('\\') && prefix.length >= 3 && CodeMirror.hint && CodeMirror.hint.anyword) {
    const anywordResult = CodeMirror.hint.anyword(cm);
    if (anywordResult && anywordResult.list) {
      for (const w of anywordResult.list) {
        if (!matches.some(m => m.text === w)) {
          matches.push({ text: w, displayText: w });
        }
      }
    }
  }

  if (matches.length === 0) return null;

  return {
    list: matches,
    from: CodeMirror.Pos(cur.line, start),
    to: CodeMirror.Pos(cur.line, cur.ch)
  };
}

// --- 2. Initialize Code Editor ---
function initEditor() {
  const textarea = document.getElementById('code-editor');
  if (typeof CodeMirror !== 'undefined') {
    editor = CodeMirror.fromTextArea(textarea, {
      mode: 'stex',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      theme: 'eclipse',
      lineWrapping: true,
      tabSize: 2,
      indentWithTabs: false,
      extraKeys: {
        'Ctrl-S': function() { triggerCompile(true); },
        'Cmd-S': function() { triggerCompile(true); },
        'Ctrl-Enter': function() { triggerCompile(true); },
        'Ctrl-Space': function(cm) { cm.showHint({ hint: latexHint, completeSingle: false }); },
        'Alt-/': function(cm) { cm.showHint({ hint: latexHint, completeSingle: false }); },
        'Ctrl-/': function(cm) { toggleComment(cm); },
        'Cmd-/': function(cm) { toggleComment(cm); },
        'Ctrl-B': function(cm) { formatBold(cm); },
        'Cmd-B': function(cm) { formatBold(cm); },
        'Ctrl-I': function(cm) { formatItalic(cm); },
        'Cmd-I': function(cm) { formatItalic(cm); },
        'Ctrl-U': function(cm) { formatUnderline(cm); },
        'Cmd-U': function(cm) { formatUnderline(cm); },
        'Ctrl-Shift-C': function(cm) { formatCode(cm); },
        'Cmd-Shift-C': function(cm) { formatCode(cm); },
        'Ctrl-Shift-M': function(cm) { formatInlineMath(cm); },
        'Cmd-Shift-M': function(cm) { formatInlineMath(cm); },
        'Ctrl-Shift-E': function(cm) { formatEquation(cm); },
        'Cmd-Shift-E': function(cm) { formatEquation(cm); },
        'Enter': function(cm) { handleSmartEnter(cm); },
        "'$'": function(cm) { if (!handleAutoSurround(cm, '$', '$')) return CodeMirror.Pass; },
        "'\"'": function(cm) { if (!handleAutoSurround(cm, "``", "''")) return CodeMirror.Pass; },
        "'{'": function(cm) { if (!handleAutoSurround(cm, '{', '}')) return CodeMirror.Pass; },
        "'('": function(cm) { if (!handleAutoSurround(cm, '(', ')')) return CodeMirror.Pass; },
        "'['": function(cm) { if (!handleAutoSurround(cm, '[', ']')) return CodeMirror.Pass; },
        'Ctrl-F': function(cm) { openSearchBar(false); },
        'Cmd-F': function(cm) { openSearchBar(false); },
        'Ctrl-H': function(cm) { openSearchBar(true); },
        'Cmd-H': function(cm) { openSearchBar(true); },
        'Ctrl-J': function(cm) { triggerSyncTeXForward(); },
        'Cmd-J': function(cm) { triggerSyncTeXForward(); },
        'Esc': function(cm) { closeSearchBar(); hideMathTooltip(); }
      }
    });

    editor.on('inputRead', (cm, change) => {
      // Trigger autocomplete when typing \ or letters
      if (change.origin === '+input') {
        const cur = cm.getCursor();
        const line = cm.getLine(cur.line);
        let start = cur.ch;
        while (start > 0 && /[\w\\@]/.test(line.charAt(start - 1))) {
          start--;
        }
        const prefix = line.slice(start, cur.ch);
        if (prefix.startsWith('\\') && prefix.length >= 2) {
          if (!cm.state.completionActive && typeof cm.showHint === 'function') {
            cm.showHint({ hint: latexHint, completeSingle: false });
          }
        }
      }
    });

    editor.on('change', (cm, changeObj) => {
      if (isSwitchingFile || (changeObj && changeObj.origin === 'setValue')) {
        return;
      }
      onCodeChanged();
      scheduleMathPreviewUpdate(editor);
    });

    editor.on('cursorActivity', () => {
      scheduleMathPreviewUpdate(editor);
    });

    editor.on('scroll', () => {
      positionMathTooltip(editor);
    });

    // Overleaf-style Double Click in Source -> Jump to PDF and Pulse Highlight
    const onSourceDblClick = () => {
      setTimeout(() => {
        if (editor && typeof editor.getCursor === 'function') {
          const cur = editor.getCursor();
          triggerSyncTeXForward(cur.line + 1);
        }
      }, 30);
    };
    editor.getWrapperElement().addEventListener('dblclick', onSourceDblClick);
    window.editor = editor;
  } else {
    // Basic textarea fallback
    editor = {
      getValue: () => textarea.value,
      setValue: (v) => { textarea.value = v; },
      setCursor: () => {},
      focus: () => textarea.focus()
    };
    textarea.addEventListener('input', onCodeChanged);
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        triggerCompile(true);
      }
    });
  }
}

function onCodeChanged() {
  setSaveStatus('saving');

  // Save to browser localStorage immediately (zero-loss safety net)
  if (currentProjectId && editor && isEditableFile(currentActiveFile)) {
    try {
      localStorage.setItem(`draft_${currentProjectId}_${currentActiveFile}`, editor.getValue());
    } catch (e) {}
  }

  // Debounced auto-save to local disk (300ms)
  if (isEditableFile(currentActiveFile)) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(saveContent, 300);
  }

  // Debounced outline update (400ms)
  clearTimeout(window._outlineTimer);
  window._outlineTimer = setTimeout(updateOutline, 400);

  // Debounced auto-compile (2500ms - silky smooth typing)
  if (autoCompileEnabled) {
    clearTimeout(compileDebounceTimer);
    compileDebounceTimer = setTimeout(() => {
      triggerCompile(false);
    }, 2500);
  }
}

// --- 3. API Communication ---
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    renderProjects(data.projects);
    
    if (data.projects.length > 0 && !currentProjectId) {
      selectProject(data.projects[0].id);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

function renderProjects(projects) {
  projectsList.innerHTML = '';
  projects.forEach(p => {
    const item = document.createElement('div');
    item.className = `project-item ${p.id === currentProjectId ? 'active' : ''}`;
    
    const isChinese = p.language === 'chinese';
    const flag = isChinese ? '🇨🇳' : '🇬🇧';
    const langLabel = isChinese ? '中文' : '英文';

    item.innerHTML = `
      <div class="project-meta">
        <span class="project-name">${flag} ${escapeHtml(p.name)}</span>
        <span class="project-sub">${langLabel} • ${p.updated_at || '刚刚'}</span>
      </div>
      <button class="btn-delete-proj" title="彻底删除该项目与缓存" data-id="${p.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-proj')) return;
      selectProject(p.id);
    });

    const deleteBtn = item.querySelector('.btn-delete-proj');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteProject(p.id, p.name);
    });

    projectsList.appendChild(item);
  });
}

let currentActiveFile = 'main.tex';

// --- File Tree Functions ---
async function loadFileTree(projectId = currentProjectId) {
  if (!projectId) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/files`);
    const data = await res.json();
    renderFileTree(data.files || []);
  } catch (err) {
    console.error('Failed to load file tree:', err);
  }
}

function downloadProjectFile(relPath) {
  if (!currentProjectId || !relPath) return;
  const fileName = relPath.split('/').pop();
  const url = `/api/projects/${currentProjectId}/raw/${encodeURIComponent(relPath)}?download=1`;
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function getFileIcon(ext, isDir) {
  if (isDir) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b" stroke="#d97706" stroke-width="1.5" style="vertical-align:-2px"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  }
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    case 'pdf':
    case 'eps':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h2a1.5 1.5 0 0 0 0-3H9v6"/></svg>`;
    case 'tex':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="12" y1="13" x2="12" y2="18"/></svg>`;
    case 'bib':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    case 'cls':
    case 'sty':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    default:
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
  }
}

function renderFileTree(files) {
  const treeList = document.getElementById('file-tree-list');
  if (!treeList) return;
  treeList.innerHTML = '';

  if (files.length === 0) {
    treeList.innerHTML = '<div style="color:#64748b; font-size:12px; padding:12px; text-align:center;">暂无文件</div>';
    return;
  }

  files.forEach(f => {
    const item = document.createElement('div');
    const isCurrent = f.path === currentActiveFile;
    const isDir = Boolean(f.is_dir);
    item.className = `tree-item ${isDir ? 'tree-dir-item' : ''} ${isCurrent ? 'active' : ''}`;

    // Visual depth indentation based on directory slashes
    const depth = Math.max(0, f.path.split('/').length - 1);
    item.style.paddingLeft = `${8 + depth * 14}px`;

    const icon = getFileIcon(f.ext, isDir);
    const isImageOrPdf = !isDir && ['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps'].includes(f.ext);
    const isEditable = !isDir && (['tex', 'bib', 'cls', 'sty', 'txt'].includes(f.ext) || !isImageOrPdf);

    if (isDir) {
      item.innerHTML = `
        <div class="tree-item-left" title="文件夹: ${escapeHtml(f.path)}">
          <span class="tree-item-icon">${icon}</span>
          <span class="tree-item-name">${escapeHtml(f.name)}</span>
        </div>
        <div class="tree-item-actions">
          <button class="tree-btn btn-folder-upload" title="上传文件到【${escapeHtml(f.name)}】">⬆</button>
          <button class="tree-btn btn-folder-new-file" title="在【${escapeHtml(f.name)}】中新建文件">+</button>
          <button class="tree-btn btn-delete-file" title="删除文件夹及其全部内容">✕</button>
        </div>
      `;

      // Folder actions
      const uploadBtn = item.querySelector('.btn-folder-upload');
      if (uploadBtn) {
        uploadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          currentUploadTargetDir = f.path;
          const inputUpload = document.getElementById('input-tree-upload');
          if (inputUpload) {
            inputUpload.value = '';
            inputUpload.click();
          }
        });
      }

      const newFileBtn = item.querySelector('.btn-folder-new-file');
      if (newFileBtn) {
        newFileBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fileName = prompt(`在文件夹【${f.path}】中新建文件（例如 sub.tex、sample.bib）：`);
          if (!fileName || !fileName.trim()) return;
          const targetRel = `${f.path}/${fileName.trim()}`;
          try {
            const res = await fetch(`/api/projects/${currentProjectId}/create_file`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: targetRel })
            });
            const data = await res.json();
            if (data.success) {
              await loadFileTree();
              await switchActiveFile(targetRel);
            } else {
              alert('创建文件失败: ' + data.error);
            }
          } catch (err) {
            alert('创建异常: ' + err);
          }
        });
      }

      const delBtn = item.querySelector('.btn-delete-file');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`确定要删除文件夹【${f.name}】及其内部所有文件吗？此操作不可逆！`)) {
            await deleteProjectFile(f.path);
          }
        });
      }
    } else {
      item.innerHTML = `
        <div class="tree-item-left" title="${escapeHtml(f.path)}">
          <span class="tree-item-icon">${icon}</span>
          <span class="tree-item-name">${escapeHtml(f.name)}</span>
        </div>
        <div class="tree-item-actions">
          ${isImageOrPdf ? `<button class="tree-btn btn-copy-figure" title="复制 LaTeX 插图代码">📋</button>` : ''}
          <button class="tree-btn btn-download-file" title="下载此文件【${escapeHtml(f.name)}】到本地">⬇</button>
          ${f.name !== 'main.tex' ? `<button class="tree-btn btn-delete-file" title="删除文件">✕</button>` : ''}
        </div>
      `;

      // Click to view/edit
      item.addEventListener('click', async (e) => {
        if (e.target.closest('.tree-btn')) return;
        if (isEditable) {
          // Restore editor if media preview was open
          document.getElementById('media-preview-wrapper').classList.add('hidden');
          document.getElementById('editor-wrapper').style.display = 'block';
          await switchActiveFile(f.path);
        } else if (isImageOrPdf) {
          await previewMediaFile(f);
        }
      });

      // Copy figure code
      const copyBtn = item.querySelector('.btn-copy-figure');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyFigureCode(f.path);
        });
      }

      // Download file
      const dlBtn = item.querySelector('.btn-download-file');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadProjectFile(f.path);
        });
      }

      // Delete file
      const delBtn = item.querySelector('.btn-delete-file');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`确定要删除文件【${f.name}】吗？`)) {
            await deleteProjectFile(f.path);
          }
        });
      }
    }

    treeList.appendChild(item);
  });
}

// Overleaf-Style Multi-Tab Management
let openEditorTabs = ['main.tex'];

function renderEditorTabs() {
  const container = document.getElementById('editor-tabs-container');
  if (!container) return;
  container.innerHTML = '';

  if (!openEditorTabs.includes('main.tex')) {
    openEditorTabs.unshift('main.tex');
  }

  openEditorTabs.forEach(filePath => {
    const tab = document.createElement('div');
    const isActive = (filePath === currentActiveFile);
    tab.className = `editor-tab ${isActive ? 'active' : ''}`;
    tab.dataset.path = filePath;
    tab.title = filePath;

    const ext = filePath.split('.').pop().toLowerCase();
    const isDir = false;
    const icon = getFileIcon(ext, isDir);
    const fileName = filePath.split('/').pop();

    tab.innerHTML = `
      <span class="editor-tab-icon">${icon}</span>
      <span class="editor-tab-name">${escapeHtml(fileName)}</span>
      ${filePath !== 'main.tex' ? `<span class="editor-tab-close" title="关闭标签页">×</span>` : ''}
    `;

    // Click tab to activate
    tab.addEventListener('click', async (e) => {
      if (e.target.closest('.editor-tab-close')) return;
      if (filePath === currentActiveFile) return;
      await activateTabByPath(filePath);
    });

    // Close tab
    const closeBtn = tab.querySelector('.editor-tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await closeEditorTab(filePath);
      });
    }

    container.appendChild(tab);
    if (isActive) {
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  });
}

function openEditorTab(filePath) {
  if (!openEditorTabs.includes(filePath)) {
    openEditorTabs.push(filePath);
  }
  renderEditorTabs();
}

async function closeEditorTab(filePath) {
  if (filePath === 'main.tex') return;
  const idx = openEditorTabs.indexOf(filePath);
  if (idx !== -1) {
    openEditorTabs.splice(idx, 1);
  }
  if (currentActiveFile === filePath) {
    const nextTab = openEditorTabs[Math.max(0, idx - 1)] || 'main.tex';
    await activateTabByPath(nextTab);
  } else {
    renderEditorTabs();
  }
}

async function activateTabByPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const isImageOrPdf = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps', 'bmp', 'webp'].includes(ext);
  if (isImageOrPdf) {
    await previewMediaFile({ path: filePath, name: filePath.split('/').pop(), ext });
  } else {
    await switchActiveFile(filePath);
  }
}

// Media Preview & Interactive Zoom/Pan State
let mediaZoom = 1.0;
let isMediaPanning = false;
let panStartX = 0, panStartY = 0;
let scrollStartLeft = 0, scrollStartTop = 0;

let mediaPdfRerenderTimer = null;
let currentMediaPdfDoc = null;
let currentMediaPdfPageNum = 1;

function updateMediaZoomUI() {
  const label = document.getElementById('media-zoom-text');
  if (label) {
    label.textContent = `${Math.round(mediaZoom * 100)}%`;
  }
  const mediaContent = document.getElementById('media-preview-content');
  if (!mediaContent) return;
  const target = mediaContent.querySelector('img, canvas');
  if (!target) return;

  const isCanvas = (target.tagName === 'CANVAS');
  const baseW = isCanvas ? (target._baseWidth || target.width) : (target.naturalWidth || 600);
  const baseH = isCanvas ? (target._baseHeight || target.height) : (target.naturalHeight || 400);

  if (Math.abs(mediaZoom - 1.0) < 0.01) {
    target.style.maxWidth = '95%';
    target.style.maxHeight = '95%';
    if (isCanvas) {
      target.style.width = `${baseW}px`;
      target.style.height = `${baseH}px`;
    } else {
      target.style.width = '';
      target.style.height = '';
    }
  } else {
    target.style.maxWidth = 'none';
    target.style.maxHeight = 'none';
    const targetW = Math.round(baseW * mediaZoom);
    const targetH = Math.round(baseH * mediaZoom);
    target.style.width = `${targetW}px`;
    target.style.height = `${targetH}px`;
  }
}

async function rerenderMediaPdfAtCurrentZoom() {
  if (!currentMediaPdfDoc) return;
  const mediaContent = document.getElementById('media-preview-content');
  if (!mediaContent) return;
  const canvas = mediaContent.querySelector('canvas');
  if (!canvas) return;

  try {
    const page = await currentMediaPdfDoc.getPage(currentMediaPdfPageNum);
    const dpr = window.devicePixelRatio || 1;
    // Render up to 5x scale for razor-sharp vector curves and text
    const renderScale = Math.min(Math.max(dpr * mediaZoom, 1.5), 5.0);
    const viewport = page.getViewport({ scale: renderScale });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (e) {
    console.warn('Dynamic PDF re-render error:', e);
  }
}

function scheduleMediaPdfRerender() {
  if (!currentMediaPdfDoc) return;
  if (mediaPdfRerenderTimer) clearTimeout(mediaPdfRerenderTimer);
  mediaPdfRerenderTimer = setTimeout(() => {
    rerenderMediaPdfAtCurrentZoom();
  }, 180);
}

function applyMediaZoom(newZoom, originX, originY) {
  const mediaContent = document.getElementById('media-preview-content');
  const target = mediaContent ? mediaContent.querySelector('img, canvas') : null;
  const oldZoom = mediaZoom;
  const clampedZoom = Math.min(10.0, Math.max(0.2, newZoom));
  if (Math.abs(clampedZoom - oldZoom) < 0.001) return;

  if (mediaContent && target) {
    const rect = mediaContent.getBoundingClientRect();
    const ox = (originX !== undefined) ? originX : (rect.width / 2);
    const oy = (originY !== undefined) ? originY : (rect.height / 2);

    const scrollX = mediaContent.scrollLeft;
    const scrollY = mediaContent.scrollTop;

    const factor = clampedZoom / oldZoom;
    const contentX = scrollX + ox;
    const contentY = scrollY + oy;

    mediaZoom = clampedZoom;
    updateMediaZoomUI();

    mediaContent.scrollLeft = Math.max(0, contentX * factor - ox);
    mediaContent.scrollTop = Math.max(0, contentY * factor - oy);
  } else {
    mediaZoom = clampedZoom;
    updateMediaZoomUI();
  }

  scheduleMediaPdfRerender();
}

function resetMediaZoom() {
  mediaZoom = 1.0;
  updateMediaZoomUI();
  const mediaContent = document.getElementById('media-preview-content');
  if (mediaContent) {
    mediaContent.scrollLeft = 0;
    mediaContent.scrollTop = 0;
  }
  scheduleMediaPdfRerender();
}

function fitMediaWidth() {
  const mediaContent = document.getElementById('media-preview-content');
  if (!mediaContent) return;
  const target = mediaContent.querySelector('img, canvas');
  if (!target) return;
  const isCanvas = (target.tagName === 'CANVAS');
  const baseW = isCanvas ? (target._baseWidth || target.width) : (target.naturalWidth || 600);
  const containerW = mediaContent.clientWidth - 48;
  if (baseW > 0 && containerW > 0) {
    const fitZoom = Math.min(Math.max(containerW / baseW, 0.2), 3.0);
    applyMediaZoom(fitZoom);
    mediaContent.scrollLeft = 0;
    mediaContent.scrollTop = 0;
  } else {
    resetMediaZoom();
  }
}

// Media Preview Functions (Directly view Image or PDF)
async function previewMediaFile(file) {
  // Flush save previous editable file before opening media preview
  if (isEditableFile(currentActiveFile)) {
    await saveContent();
  }

  const mediaWrapper = document.getElementById('media-preview-wrapper');
  const editorWrapper = document.getElementById('editor-wrapper');
  const mediaTitle = document.getElementById('media-preview-title');
  const mediaContent = document.getElementById('media-preview-content');
  const editorTools = document.getElementById('editor-tools');
  const formatBar = document.getElementById('editor-format-bar');

  // Hide CodeMirror editor, formatting bar & text tools, show media preview
  editorWrapper.style.display = 'none';
  if (formatBar) {
    formatBar.classList.add('hidden');
    formatBar.style.display = 'none';
  }
  if (editorTools) {
    editorTools.classList.add('hidden');
    editorTools.style.display = 'none';
  }
  mediaWrapper.classList.remove('hidden');

  currentActiveFile = file.path;
  openEditorTab(file.path);
  const fileNameHeader = document.querySelector('.pane-header .file-name');
  if (fileNameHeader) fileNameHeader.textContent = `🖼️ ${file.name}`;
  if (mediaTitle) {
    mediaTitle.textContent = `${file.name} (${Math.round((file.size || 0) / 1024)} KB)`;
    mediaTitle.title = `${file.name} (${Math.round((file.size || 0) / 1024)} KB)`;
  }

  const fileUrl = `/api/projects/${currentProjectId}/raw/${encodeURIComponent(file.path)}?t=${Date.now()}`;
  const isPdf = file.ext === 'pdf';

  // Reset zoom & scroll state
  mediaZoom = 1.0;
  currentMediaPdfDoc = null;
  if (mediaContent) {
    mediaContent.scrollLeft = 0;
    mediaContent.scrollTop = 0;
  }

  if (isPdf) {
    mediaContent.innerHTML = '<div id="media-pdf-loading" style="color:#94a3b8; font-size:13px; display:flex; align-items:center; gap:8px;">⏳ 正在渲染矢量 PDF 图形...</div>';
    const zoomControls = document.getElementById('media-zoom-controls');
    if (zoomControls) zoomControls.style.display = 'flex';

    try {
      const loadingTask = createPdfLoadingTask(fileUrl);
      const pdfDoc = await loadingTask.promise;
      currentMediaPdfDoc = pdfDoc;
      currentMediaPdfPageNum = 1;
      const page = await pdfDoc.getPage(1);

      // Render at high resolution (2x DPR) for crisp vector graphics
      const dpr = Math.max(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: dpr });

      const canvas = document.createElement('canvas');
      canvas.className = 'media-preview-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const displayW = Math.floor(viewport.width / dpr);
      const displayH = Math.floor(viewport.height / dpr);
      canvas.style.width = displayW + 'px';
      canvas.style.height = displayH + 'px';
      canvas._baseWidth = displayW;
      canvas._baseHeight = displayH;

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      mediaContent.innerHTML = '';
      mediaContent.appendChild(canvas);
      updateMediaZoomUI();
    } catch (err) {
      console.warn('PDF.js render failed, fallback to iframe:', err);
      currentMediaPdfDoc = null;
      mediaContent.innerHTML = `<iframe src="${fileUrl}" frameborder="0" style="width:100%;height:100%;"></iframe>`;
      if (zoomControls) zoomControls.style.display = 'none';
    }
  } else {
    currentMediaPdfDoc = null;
    mediaContent.innerHTML = `<img src="${fileUrl}" alt="${escapeHtml(file.name)}">`;
    const zoomControls = document.getElementById('media-zoom-controls');
    if (zoomControls) zoomControls.style.display = 'flex';
    updateMediaZoomUI();
  }

  // Hide outline when previewing media
  document.getElementById('outline-resizer').style.display = 'none';
  document.getElementById('file-outline-container').style.display = 'none';

  // Highlight in file tree and update tabs
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('.tree-item-left')?.title === file.path);
  });
  renderEditorTabs();
}

function copyFigureCode(relPath) {
  const baseName = relPath.split('/').pop().replace(/\.[^/.]+$/, "");
  const cleanLabel = baseName.replace(/[^\w-]/g, '_');
  const code = `\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.85\\linewidth]{${relPath}}
  \\caption{这里输入图注说明}
  \\label{fig:${cleanLabel}}
\\end{figure}`;
  navigator.clipboard.writeText(code).then(() => {
    setCompileStatus('idle', `已复制 ${relPath} 插图代码！`);
    setTimeout(() => {
      setCompileStatus('idle', autoCompileEnabled ? '就绪' : '自动编译已暂停');
    }, 2500);
  }).catch(() => {
    alert(`LaTeX 插图代码：\n\n${code}`);
  });
}

// File Outline Functions
function updateOutline() {
  const outlineList = document.getElementById('file-outline-list');
  const outlineResizer = document.getElementById('outline-resizer');
  const outlineContainer = document.getElementById('file-outline-container');
  if (!outlineList || !editor) return;

  // Only show outline for .tex files!
  if (!currentActiveFile || !currentActiveFile.toLowerCase().endsWith('.tex')) {
    if (outlineResizer) outlineResizer.style.display = 'none';
    if (outlineContainer) outlineContainer.style.display = 'none';
    return;
  } else {
    if (outlineResizer) outlineResizer.style.display = 'flex';
    if (outlineContainer) outlineContainer.style.display = 'flex';
  }

  const content = editor.getValue();
  const lines = content.split('\n');
  const items = [];
  const secRegex = /\\(section|subsection|subsubsection)\*?\{([^}]+)\}/;

  lines.forEach((line, idx) => {
    const m = line.match(secRegex);
    if (m) {
      const type = m[1];
      const title = m[2].trim();
      let level = 1;
      if (type === 'subsection') level = 2;
      else if (type === 'subsubsection') level = 3;
      items.push({ line: idx, title, level });
    }
  });

  outlineList.innerHTML = '';
  if (items.length === 0) {
    outlineList.innerHTML = '<div style="color:#64748b; font-size:11px; padding:10px 12px;">暂无章节标记 (\\section)</div>';
    return;
  }

  items.forEach(it => {
    const div = document.createElement('div');
    div.className = `outline-item outline-level-${it.level}`;
    div.textContent = it.title;
    div.title = `跳转至第 ${it.line + 1} 行: ${it.title}`;
    div.addEventListener('click', () => {
      if (editor) {
        editor.setCursor({ line: it.line, ch: 0 });
        editor.scrollIntoView({ line: it.line, ch: 0 }, 100);
        editor.focus();
      }
    });
    outlineList.appendChild(div);
  });
}

function initOutlineResizer() {
  const outlineResizer = document.getElementById('outline-resizer');
  const outlineContainer = document.getElementById('file-outline-container');
  if (!outlineResizer || !outlineContainer) return;

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;
  let rafId = null;

  outlineResizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startHeight = outlineContainer.offsetHeight;
    outlineResizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    pdfPane.style.pointerEvents = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const currentY = e.clientY;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const deltaY = startY - currentY;
      const newHeight = Math.min(Math.max(startHeight + deltaY, 32), 480);
      outlineContainer.style.height = `${newHeight}px`;
    });
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      if (rafId) cancelAnimationFrame(rafId);
      outlineResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      pdfPane.style.pointerEvents = '';
    }
  });

  // Toggle outline collapsed
  const toggleBtn = document.getElementById('outline-header-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      outlineContainer.classList.toggle('collapsed');
    });
  }
}

async function switchActiveFile(relPath) {
  // If user requested a non-editable media/view-only file, route to previewMediaFile
  if (!isEditableFile(relPath)) {
    const ext = relPath.split('.').pop().toLowerCase();
    await previewMediaFile({ path: relPath, name: relPath.split('/').pop(), ext });
    return;
  }

  const mediaWrapper = document.getElementById('media-preview-wrapper');
  const editorWrapper = document.getElementById('editor-wrapper');
  const editorTools = document.getElementById('editor-tools');
  const formatBar = document.getElementById('editor-format-bar');

  if (currentActiveFile === relPath) {
    if (mediaWrapper && editorWrapper) {
      mediaWrapper.classList.add('hidden');
      editorWrapper.style.display = 'block';
    }
    if (formatBar) {
      formatBar.classList.remove('hidden');
      formatBar.style.display = '';
    }
    if (editorTools) {
      editorTools.classList.remove('hidden');
      editorTools.style.display = '';
    }
    renderEditorTabs();
    return;
  }

  // Cancel pending timers from previous file before switching
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  if (compileDebounceTimer) {
    clearTimeout(compileDebounceTimer);
    compileDebounceTimer = null;
  }

  // Flush save previous file first only if it was an editable file
  if (isEditableFile(currentActiveFile)) {
    await saveContent();
  }
  currentActiveFile = relPath;
  openEditorTab(relPath);

  if (mediaWrapper && editorWrapper) {
    mediaWrapper.classList.add('hidden');
    editorWrapper.style.display = 'block';
  }
  if (formatBar) {
    formatBar.classList.remove('hidden');
    formatBar.style.display = '';
  }
  if (editorTools) {
    editorTools.classList.remove('hidden');
    editorTools.style.display = '';
  }

  const fileNameHeader = document.querySelector('.pane-header .file-name');
  if (fileNameHeader) fileNameHeader.textContent = `📄 ${relPath}`;

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/content?path=${encodeURIComponent(relPath)}`);
    const data = await res.json();
    if (data.content !== undefined) {
      isSwitchingFile = true;
      try {
        editor.setValue(data.content);
      } finally {
        isSwitchingFile = false;
      }
      loadFileTree();
      updateOutline();
      renderEditorTabs();
      setSaveStatus('saved');
    }
  } catch (err) {
    console.error('Failed to switch file:', err);
  }
}

let currentUploadTargetDir = '';

async function deleteProjectFile(relPath) {
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/delete_file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath })
    });
    const data = await res.json();
    if (data.success) {
      openEditorTabs = openEditorTabs.filter(p => p !== relPath && !p.startsWith(relPath + '/'));
      if (!openEditorTabs.includes('main.tex')) {
        openEditorTabs.unshift('main.tex');
      }
      if (currentActiveFile === relPath || currentActiveFile.startsWith(relPath + '/')) {
        await switchActiveFile('main.tex');
      } else {
        loadFileTree();
        renderEditorTabs();
      }
    } else {
      alert('删除失败: ' + data.error);
    }
  } catch (err) {
    alert('删除异常: ' + err);
  }
}

async function uploadFilesToProject(fileList, targetDir = '') {
  if (!currentProjectId || !fileList || fileList.length === 0) return;
  setCompileStatus('compiling', '正在上传文件/图片...');
  fetch('/api/system/heartbeat', { method: 'POST' }).catch(() => {});
  const formData = new FormData();
  if (targetDir) {
    formData.append('target_dir', targetDir);
  }
  for (let i = 0; i < fileList.length; i++) {
    formData.append('files', fileList[i]);
  }

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/upload_file`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      setCompileStatus('success', `成功上传 ${data.uploaded.length} 个文件`);
      await loadFileTree();
      triggerCompile(true);
    } else {
      setCompileStatus('error', '上传失败');
      alert('上传失败: ' + data.error);
    }
  } catch (err) {
    setCompileStatus('error', '上传异常');
    alert('上传异常: ' + err);
  }
}

async function selectProject(projectId) {
  // Cancel pending timers from previous project before switching
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  if (compileDebounceTimer) {
    clearTimeout(compileDebounceTimer);
    compileDebounceTimer = null;
  }

  currentProjectId = projectId;
  currentActiveFile = 'main.tex';
  openEditorTabs = ['main.tex'];
  hideDiagnosticBanner();
  hideErrors();

  const formatBar = document.getElementById('editor-format-bar');
  if (formatBar) {
    formatBar.classList.remove('hidden');
    formatBar.style.display = '';
  }
  const editorTools = document.getElementById('editor-tools');
  if (editorTools) {
    editorTools.classList.remove('hidden');
    editorTools.style.display = '';
  }
  const mediaWrapper = document.getElementById('media-preview-wrapper');
  const editorWrapper = document.getElementById('editor-wrapper');
  if (mediaWrapper && editorWrapper) {
    mediaWrapper.classList.add('hidden');
    editorWrapper.style.display = 'block';
  }
  renderEditorTabs();
  const fileNameHeader = document.querySelector('.pane-header .file-name');
  if (fileNameHeader) fileNameHeader.textContent = `📄 main.tex`;

  // Update active state in UI
  document.querySelectorAll('.project-item').forEach(el => {
    el.classList.toggle('active', el.querySelector(`[data-id="${projectId}"]`) !== null);
  });

  try {
    const res = await fetch(`/api/projects/${projectId}/content?path=main.tex`);
    const data = await res.json();
    
    // Check if localStorage has newer draft
    isSwitchingFile = true;
    try {
      const localDraft = localStorage.getItem(`draft_${projectId}_main.tex`);
      if (localDraft && localDraft.length !== data.content.length) {
        editor.setValue(localDraft);
      } else {
        editor.setValue(data.content);
      }
    } finally {
      isSwitchingFile = false;
    }

    setSaveStatus('saved');

    // Fetch meta
    const projRes = await fetch('/api/projects');
    const pData = await projRes.json();
    const meta = pData.projects.find(p => p.id === projectId);
    if (meta) {
      currentProjectMeta = meta;
      document.getElementById('current-project-title').textContent = meta.name;
      const langText = document.getElementById('current-project-lang-text');
      if (langText) {
        langText.textContent = meta.language === 'chinese' ? '🇨🇳 中文 (CTeX)' : '🇬🇧 英文 (Standard)';
      }
      updateLangDropdownChecks(meta.language);
      
      if (meta.has_pdf) {
        showPdf(`/api/projects/${projectId}/pdf?t=${Date.now()}`);
      } else {
        showPdfPlaceholder();
      }
    }

    // Refresh file tree & outline
    await loadFileTree(projectId);
    updateOutline();
  } catch (err) {
    console.error('Failed to load project content:', err);
  }
}

async function saveContent() {
  if (!currentProjectId || !editor) return;
  if (!isEditableFile(currentActiveFile)) return;
  const content = editor.getValue();
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/content?path=${encodeURIComponent(currentActiveFile)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, path: currentActiveFile })
    });
    const data = await res.json();
    const timeStr = data.saved_at || (new Date().toTimeString().split(' ')[0]);
    setSaveStatus('saved', timeStr);
  } catch (err) {
    setSaveStatus('error');
  }
}

async function triggerCompile(isManual = false) {
  if (!currentProjectId || isCompiling) return;
  isCompiling = true;
  setCompileStatus('compiling', '编译中...');

  const payload = {};
  if (currentActiveFile === 'main.tex' && editor) {
    payload.content = editor.getValue();
  }
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (result.diagnostics && result.diagnostics.length > 0) {
      showDiagnosticBanner({ ...result.diagnostics[0], source: 'compiler' });
    } else {
      // Only auto-dismiss compiler diagnostics.
      // NEVER auto-dismiss user-action prompts (e.g. language switch recommendations),
      // allow the user sufficient time to read and choose "一键注释" or "保留现状".
      if (_activeDiagnostic && _activeDiagnostic.source === 'compiler') {
        hideDiagnosticBanner();
      }
    }

    if (result.success) {
      lastCompileTimestamp = Date.now();
      lastCompileDurationSec = result.duration;
      setCompileStatus('success', `成功 (${result.duration}s)`);
      showPdf(result.pdf_url);
      hideErrors();
      updateCompileStatusTooltip();
      setSaveStatus('saved');
    } else {
      lastCompileTimestamp = Date.now();
      lastCompileDurationSec = null;
      setCompileStatus('error', '编译报错');
      displayErrors(result.errors || [], result.log);
      updateCompileStatusTooltip();
    }
  } catch (err) {
    lastCompileTimestamp = Date.now();
    lastCompileDurationSec = null;
    setCompileStatus('error', '服务异常');
    displayErrors([{ line: 1, message: String(err) }], String(err));
    updateCompileStatusTooltip();
  } finally {
    isCompiling = false;
  }
}

// --- 3.5 Native PDF.js Rendering & Double-Click Bidirectional SyncTeX ---
async function showPdf(url) {
  if (!url) return;
  currentPdfUrl = url;
  pdfPlaceholder.style.display = 'none';
  pdfContainer.style.display = 'flex';
  document.getElementById('btn-download-pdf').href = url;

  if (typeof pdfjsLib === 'undefined') {
    pdfContainer.innerHTML = '<div style="color:#ef4444;padding:20px;">PDF.js 渲染引擎未就绪</div>';
    return;
  }

  try {
    // Cancel any active render tasks
    pdfRenderTasks.forEach(t => { try { t.cancel(); } catch(e){} });
    pdfRenderTasks = [];

    const loadingTask = createPdfLoadingTask(url);
    currentPdfDoc = await loadingTask.promise;
    
    updatePageIndicator(1, currentPdfDoc.numPages);
    await renderAllPdfPages();
  } catch (err) {
    if (err.name !== 'RenderingCancelledException') {
      console.error('Error loading PDF with PDF.js:', err);
    }
  }
}

function showPdfPlaceholder() {
  currentPdfDoc = null;
  currentPdfUrl = null;
  pdfContainer.style.display = 'none';
  pdfPlaceholder.style.display = 'flex';
  updatePageIndicator(0, 0);
}

function updatePageIndicator(cur, total) {
  const el = document.getElementById('pdf-page-indicator');
  if (el) {
    el.textContent = total > 0 ? `第 ${cur} / ${total} 页` : '第 1 / 1 页';
  }
}

let pendingPdfRender = false;
let pdfRenderDebounceTimer = null;

function requestPdfRender(delay = 40) {
  if (pdfRenderDebounceTimer) {
    clearTimeout(pdfRenderDebounceTimer);
  }
  pdfRenderDebounceTimer = setTimeout(() => {
    renderAllPdfPages();
  }, delay);
}

async function renderAllPdfPages() {
  if (!currentPdfDoc || !pdfContainer) return;
  if (isRenderingPdf) {
    // If a render is already running, abort current render tasks immediately
    // and flag that a new render is pending with the latest target scale!
    pendingPdfRender = true;
    pdfRenderTasks.forEach(t => { try { t.cancel(); } catch(e){} });
    pdfRenderTasks = [];
    return;
  }
  isRenderingPdf = true;
  pendingPdfRender = false;

  // Cancel prior renders
  pdfRenderTasks.forEach(t => { try { t.cancel(); } catch(e){} });
  pdfRenderTasks = [];

  const scrollPos = pdfContainer.scrollTop;
  pdfContainer.innerHTML = '';

  const numPages = currentPdfDoc.numPages;
  const dpr = window.devicePixelRatio || 1;

  try {
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (pendingPdfRender) {
        // Abort loop early if an even newer render request was queued!
        break;
      }
      const page = await currentPdfDoc.getPage(pageNum);
      
      // Calculate effective scale
      let scale = pdfScale;
      if (isFitWidth) {
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const containerWidth = Math.max(300, pdfContainer.clientWidth - 48);
        scale = containerWidth / unscaledViewport.width;
      }

      const viewport = page.getViewport({ scale: scale });

      const pageWrapper = document.createElement('div');
      pageWrapper.className = 'pdf-page-wrapper';
      pageWrapper.id = `pdf-page-${pageNum}`;
      pageWrapper.dataset.page = pageNum;
      pageWrapper.dataset.scale = scale;
      pageWrapper.style.width = Math.floor(viewport.width) + 'px';
      pageWrapper.style.height = Math.floor(viewport.height) + 'px';

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
      textLayerDiv.style.height = Math.floor(viewport.height) + 'px';

      const highlightOverlay = document.createElement('div');
      highlightOverlay.className = 'pdf-highlight-overlay';

      pageWrapper.appendChild(canvas);
      pageWrapper.appendChild(textLayerDiv);
      pageWrapper.appendChild(highlightOverlay);
      pdfContainer.appendChild(pageWrapper);

      // Overleaf-style Double Click in PDF -> Jump to Source Line (Backward SyncTeX)
      pageWrapper.addEventListener('dblclick', (e) => {
        const rect = pageWrapper.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const effScale = parseFloat(pageWrapper.dataset.scale) || pdfScale;
        const ptX = clickX / effScale;
        const ptY = clickY / effScale;
        triggerSyncTeXBackward(pageNum, ptX, ptY);
      });

      const renderContext = {
        canvasContext: ctx,
        viewport: viewport
      };
      const renderTask = page.render(renderContext);
      pdfRenderTasks.push(renderTask);
      await renderTask.promise;

      // Render PDF.js TextLayer for native text selection, search & copying
      try {
        const textContent = await page.getTextContent();
        const textLayerRender = pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport,
          textDivs: []
        });
        await textLayerRender.promise;
      } catch (tErr) {
        if (tErr.name !== 'RenderingCancelledException') {
          console.warn('TextLayer render warning:', tErr);
        }
      }

      // Yield to browser event loop between pages to maintain 60fps UI responsiveness
      await new Promise(r => setTimeout(r, 12));
    }
  } catch (err) {
    if (err.name !== 'RenderingCancelledException') {
      console.warn('PDF render error:', err);
    }
  } finally {
    isRenderingPdf = false;
    pdfContainer.scrollTop = scrollPos;
    if (pendingPdfRender) {
      pendingPdfRender = false;
      setTimeout(() => renderAllPdfPages(), 15);
    }
  }
}

function initPdfControls() {
  const btnZoomIn = document.getElementById('btn-pdf-zoom-in');
  const btnZoomOut = document.getElementById('btn-pdf-zoom-out');
  const btnFitWidth = document.getElementById('btn-pdf-fit-width');
  const zoomText = document.getElementById('pdf-zoom-text');

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      isFitWidth = false;
      pdfScale = Math.min(2.5, pdfScale + 0.15);
      if (zoomText) zoomText.textContent = Math.round(pdfScale * 100) + '%';
      requestPdfRender(40);
    });
  }

  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      isFitWidth = false;
      pdfScale = Math.max(0.5, pdfScale - 0.15);
      if (zoomText) zoomText.textContent = Math.round(pdfScale * 100) + '%';
      requestPdfRender(40);
    });
  }

  if (btnFitWidth) {
    btnFitWidth.addEventListener('click', () => {
      isFitWidth = true;
      if (zoomText) zoomText.textContent = '适应';
      requestPdfRender(40);
    });
  }

  // Ctrl + Wheel to zoom inside PDF
  if (pdfContainer) {
    pdfContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        isFitWidth = false;
        if (e.deltaY < 0) {
          pdfScale = Math.min(2.5, pdfScale + 0.1);
        } else {
          pdfScale = Math.max(0.5, pdfScale - 0.1);
        }
        if (zoomText) zoomText.textContent = Math.round(pdfScale * 100) + '%';
        requestPdfRender(50);
      }
    }, { passive: false });

    // Track scroll position for page indicator
    pdfContainer.addEventListener('scroll', () => {
      if (!currentPdfDoc) return;
      const pages = pdfContainer.querySelectorAll('.pdf-page-wrapper');
      const containerTop = pdfContainer.scrollTop;
      for (let p of pages) {
        if (p.offsetTop + p.clientHeight / 2 >= containerTop) {
          const curP = p.dataset.page || 1;
          updatePageIndicator(curP, currentPdfDoc.numPages);
          break;
        }
      }
    });
  }
}

let lastCompileTimestamp = null;
let lastCompileDurationSec = null;

function updateCompileStatusTooltip() {
  if (!compileStatus) return;
  const ts = lastCompileTimestamp || window.lastCompileTimestamp;
  const dur = (lastCompileDurationSec !== null && lastCompileDurationSec !== undefined) ? lastCompileDurationSec : window.lastCompileDurationSec;
  if (!ts) {
    compileStatus.title = '尚未进行编译 (点击“编译”按钮或按 Ctrl+S 开始)';
    return;
  }
  const now = Date.now();
  const elapsedSec = Math.floor((now - ts) / 1000);
  let timeAgo = '';
  if (elapsedSec < 3) {
    timeAgo = '刚刚';
  } else if (elapsedSec < 60) {
    timeAgo = `${elapsedSec} 秒前`;
  } else if (elapsedSec < 3600) {
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    timeAgo = `${m} 分 ${s} 秒前`;
  } else {
    const h = Math.floor(elapsedSec / 3600);
    const m = Math.floor((elapsedSec % 3600) / 60);
    timeAgo = `${h} 小时 ${m} 分前`;
  }
  const timeStr = new Date(ts).toTimeString().split(' ')[0];
  let msg = `上次编译：${timeStr} (${timeAgo})`;
  if (dur !== null && dur !== undefined) {
    msg += `\n本次编译用时：${dur}s`;
  }
  compileStatus.title = msg;
}

function setCompileStatus(type, text) {
  compileStatus.className = `status-indicator ${type}`;
  compileStatus.querySelector('.status-text').textContent = text;
  updateCompileStatusTooltip();
}

function initMediaPreviewInteractions() {
  const mediaContent = document.getElementById('media-preview-content');
  if (mediaContent) {
    // Mouse pan/grab
    mediaContent.addEventListener('mousedown', (e) => {
      const target = mediaContent.querySelector('img, canvas');
      if (!target) return;
      isMediaPanning = true;
      mediaContent.classList.add('grabbing');
      target.classList.add('grabbing');
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartLeft = mediaContent.scrollLeft;
      scrollStartTop = mediaContent.scrollTop;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isMediaPanning) return;
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      mediaContent.scrollLeft = scrollStartLeft - dx;
      mediaContent.scrollTop = scrollStartTop - dy;
    });

    window.addEventListener('mouseup', () => {
      if (isMediaPanning) {
        isMediaPanning = false;
        mediaContent.classList.remove('grabbing');
        const target = mediaContent.querySelector('img, canvas');
        if (target) target.classList.remove('grabbing');
      }
    });

    // Ctrl + Wheel zoom towards cursor
    mediaContent.addEventListener('wheel', (e) => {
      const target = mediaContent.querySelector('img, canvas');
      if (!target) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        const rect = mediaContent.getBoundingClientRect();
        applyMediaZoom(mediaZoom * factor, e.clientX - rect.left, e.clientY - rect.top);
      }
    }, { passive: false });

    // Double click to reset
    mediaContent.addEventListener('dblclick', (e) => {
      if (mediaContent.querySelector('img, canvas')) {
        resetMediaZoom();
      }
    });
  }

  // Toolbar zoom buttons
  const btnZoomIn = document.getElementById('btn-media-zoom-in');
  const btnZoomOut = document.getElementById('btn-media-zoom-out');
  const btnFit = document.getElementById('btn-media-fit-width');
  if (btnZoomIn) btnZoomIn.addEventListener('click', () => applyMediaZoom(mediaZoom * 1.2));
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => applyMediaZoom(mediaZoom / 1.2));
  if (btnFit) btnFit.addEventListener('click', fitMediaWidth);

  // Horizontal wheel scroll on tabs
  const tabsContainer = document.getElementById('editor-tabs-container');
  if (tabsContainer) {
    tabsContainer.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        tabsContainer.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

  // Horizontal wheel scroll on media preview toolbar
  const mediaToolbar = document.getElementById('media-preview-toolbar');
  if (mediaToolbar) {
    mediaToolbar.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0 && !e.ctrlKey) {
        e.preventDefault();
        mediaToolbar.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

  // Hover on compileStatus
  if (compileStatus) {
    compileStatus.addEventListener('mouseenter', updateCompileStatusTooltip);
  }

  // Initial render of tabs
  renderEditorTabs();
}

// --- 4. Error Handling ---
function displayErrors(errors, fullLog) {
  if (!errorPanel) return;
  errorList.innerHTML = '';
  if (errors.length === 0 && fullLog) {
    errors = [{ line: 1, message: fullLog.slice(0, 300) }];
  }
  
  if (errorTitle) {
    errorTitle.textContent = `⚠️ 编译报错 (${errors.length})`;
  }

  errors.forEach(err => {
    const item = document.createElement('div');
    item.className = 'error-item';
    item.textContent = `[第 ${err.line} 行] ${err.message}`;
    item.addEventListener('click', () => {
      const mediaWrapper = document.getElementById('media-preview-wrapper');
      const editorWrapper = document.getElementById('editor-wrapper');
      if (mediaWrapper && editorWrapper) {
        mediaWrapper.classList.add('hidden');
        editorWrapper.style.display = 'block';
      }
      if (editor && editor.setCursor) {
        editor.setCursor({ line: Math.max(0, err.line - 1), ch: 0 });
        editor.focus();
      }
    });
    errorList.appendChild(item);
  });

  errorPanel.classList.remove('hidden');
  errorPanel.classList.remove('collapsed');
  const toggleIcon = document.getElementById('error-toggle-icon');
  if (toggleIcon) toggleIcon.textContent = '▼';
}

function hideErrors() {
  if (!errorPanel) return;
  errorPanel.classList.add('hidden');
  errorPanel.classList.add('collapsed');
  if (errorList) errorList.innerHTML = '';
  if (errorTitle) errorTitle.textContent = '⚠️ 编译报错 (0)';
}

// --- 5. Silky Smooth Resizable Splitters (Delta-Based, Zero Offset) ---
function initSplitters() {
  // Drawer Resizer
  let isDraggingDrawer = false;
  let drawerStartX = 0;
  let drawerStartWidth = 0;

  drawerResizer.addEventListener('mousedown', (e) => {
    isDraggingDrawer = true;
    drawerStartX = e.clientX;
    drawerStartWidth = drawer.offsetWidth;
    drawerResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    pdfPane.style.pointerEvents = 'none'; // CRITICAL: Stop iframe from capturing mouse
    e.preventDefault();
  });

  // Center Split Resizer (Code vs PDF)
  let isDraggingSplit = false;
  let splitStartX = 0;
  let splitStartLeftWidth = 0;

  splitResizer.addEventListener('mousedown', (e) => {
    if (e.target.closest('#split-synctex-nav')) return;
    isDraggingSplit = true;
    splitStartX = e.clientX;
    splitStartLeftWidth = editorPane.offsetWidth;
    splitResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    pdfPane.style.pointerEvents = 'none'; // CRITICAL: Stop iframe from capturing mouse
    e.preventDefault();
  });

  let splitRafId = null;

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingDrawer && !isDraggingSplit) return;
    const clientX = e.clientX;

    if (splitRafId) cancelAnimationFrame(splitRafId);
    splitRafId = requestAnimationFrame(() => {
      if (isDraggingDrawer) {
        const deltaX = clientX - drawerStartX;
        const newWidth = Math.min(Math.max(drawerStartWidth + deltaX, 160), 450);
        drawer.style.width = `${newWidth}px`;
      } else if (isDraggingSplit) {
        const deltaX = clientX - splitStartX;
        const workspaceRect = document.getElementById('main-workspace').getBoundingClientRect();
        const drawerWidth = document.body.classList.contains('drawer-collapsed') ? 0 : drawer.offsetWidth;
        const totalAvailable = workspaceRect.width - drawerWidth - splitResizer.offsetWidth;
        
        if (totalAvailable > 360) {
          const newLeftWidth = Math.min(Math.max(splitStartLeftWidth + deltaX, 180), totalAvailable - 180);
          splitRatio = newLeftWidth / totalAvailable;
          applySplitRatio();
        }
      }
    });
  });

  window.addEventListener('mouseup', () => {
    if (splitRafId) cancelAnimationFrame(splitRafId);
    if (isDraggingDrawer) {
      isDraggingDrawer = false;
      drawerResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      pdfPane.style.pointerEvents = '';
      if (editor && editor.refresh) editor.refresh();
    }
    if (isDraggingSplit) {
      isDraggingSplit = false;
      splitResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      pdfPane.style.pointerEvents = '';
      try {
        localStorage.setItem('paperleaf_split_ratio', splitRatio.toString());
      } catch (e) {}
      if (editor && editor.refresh) editor.refresh();
    }
  });
}

// --- 6. View Mode Switching ---
function setViewMode(mode) {
  currentViewMode = mode;
  document.body.classList.remove('mode-code', 'mode-paper');
  document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));

  if (mode === 'code') {
    document.body.classList.add('mode-code');
    document.getElementById('btn-view-code').classList.add('active');
  } else if (mode === 'paper') {
    document.body.classList.add('mode-paper');
    document.getElementById('btn-view-paper').classList.add('active');
    hideMathTooltip();
  } else {
    // split mode
    document.getElementById('btn-view-split').classList.add('active');
    applySplitRatio();
  }

  if (editor && editor.refresh) {
    setTimeout(() => {
      editor.refresh();
      if (mode !== 'paper') scheduleMathPreviewUpdate(editor);
    }, 100);
  }
}

// --- 7. Project Creation & Deletion ---
function initProjectModal() {
  const modal = document.getElementById('modal-new-project');
  const btnNew = document.getElementById('btn-new-project');
  const btnClose = document.getElementById('btn-close-modal');
  const btnCancel = document.getElementById('btn-cancel-modal');
  const btnConfirm = document.getElementById('btn-confirm-create');
  const inputName = document.getElementById('input-project-name');

  btnNew.addEventListener('click', () => {
    inputName.value = '';
    modal.classList.remove('hidden');
    inputName.focus();
  });

  const closeModal = () => modal.classList.add('hidden');
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  btnConfirm.addEventListener('click', async () => {
    const name = inputName.value.trim() || '未命名论文项目';
    const lang = document.querySelector('input[name="project-lang"]:checked').value;

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, language: lang })
      });
      const data = await res.json();
      closeModal();
      await loadProjects();
      selectProject(data.project.id);
      triggerCompile(true);
    } catch (err) {
      alert('创建项目失败: ' + err);
    }
  });
}

async function confirmDeleteProject(id, name) {
  const msg = `确定要删除项目【${name}】吗？\n\n` +
    `✓ 仅删除软件内部存储的源码及预览缓存（释放本地磁盘空间）。\n` +
    `✓ 请放心：绝不会影响你已经下载或导出到电脑其他位置的 PDF 文件！`;
  if (confirm(msg)) {
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (currentProjectId === id) {
        currentProjectId = null;
      }
      await loadProjects();
    } catch (err) {
      alert('删除失败: ' + err);
    }
  }
}

// --- 8. ZIP Archive Upload & Export ---
function initZipFeatures() {
  const btnImport = document.getElementById('btn-import-zip');
  const inputZip = document.getElementById('input-zip-file');
  const btnExport = document.getElementById('btn-export-zip');

  if (btnImport && inputZip) {
    btnImport.addEventListener('click', () => {
      inputZip.value = '';
      inputZip.click();
    });

    inputZip.addEventListener('change', async () => {
      const file = inputZip.files[0];
      if (!file) return;
      await uploadZipFile(file);
    });
  }

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      if (!currentProjectId) {
        alert('请先选择一个项目进行导出');
        return;
      }
      window.open(`/api/projects/${currentProjectId}/export_zip`, '_blank');
    });
  }

  // Drag and drop ZIP support
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.zip')) {
        if (confirm(`检测到拖入压缩包【${file.name}】，是否立即作为新项目导入？`)) {
          await uploadZipFile(file);
        }
      }
    }
  });
}

async function uploadZipFile(file) {
  setCompileStatus('compiling', '正在解压导入 ZIP...');
  // Send instant heartbeat to ensure backend is fully aware
  fetch('/api/system/heartbeat', { method: 'POST' }).catch(() => {});
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/projects/upload_zip', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (result.success) {
      setCompileStatus('success', 'ZIP 导入成功');
      await loadProjects();
      selectProject(result.project.id);
      triggerCompile(true);
    } else {
      setCompileStatus('error', '导入失败');
      alert('导入失败: ' + (result.error || '未知错误'));
    }
  } catch (err) {
    setCompileStatus('error', '上传异常');
    alert('上传异常: ' + err);
  }
}

// --- 9. Storage / Settings Modal ---
async function refreshSystemStorageInfo() {
  try {
    const res = await fetch('/api/system/info');
    const info = await res.json();
    const cacheDirEl = document.getElementById('info-cache-dir');
    if (cacheDirEl) cacheDirEl.textContent = info.cache_dir;
    const cacheSizeEl = document.getElementById('info-cache-size');
    if (cacheSizeEl) cacheSizeEl.textContent = `${info.cache_size_mb} MB`;
    const projectsDirEl = document.getElementById('info-projects-dir');
    if (projectsDirEl) projectsDirEl.textContent = info.projects_dir;
    const drawerProjectsDir = document.getElementById('drawer-projects-dir');
    if (drawerProjectsDir) {
      drawerProjectsDir.textContent = info.projects_dir;
      drawerProjectsDir.title = info.projects_dir;
    }
    return info;
  } catch (err) {
    console.error('Failed to load system info:', err);
  }
}

function initStorageModal() {
  const modal = document.getElementById('modal-storage');
  const btnOpen = document.getElementById('btn-settings');
  const btnClose = document.getElementById('btn-close-storage');
  const btnOk = document.getElementById('btn-ok-storage');

  if (!modal) return;

  // 1. Subnav Tab Switching (Fonts vs Storage)
  const btnTabFonts = document.getElementById('btn-tab-fonts');
  const btnTabStorage = document.getElementById('btn-tab-storage');
  const paneFonts = document.getElementById('settings-tab-fonts');
  const paneStorage = document.getElementById('settings-tab-storage');

  const switchTab = (tab) => {
    if (tab === 'fonts') {
      if (btnTabFonts) btnTabFonts.classList.add('active');
      if (btnTabStorage) btnTabStorage.classList.remove('active');
      if (paneFonts) {
        paneFonts.classList.remove('hidden');
        paneFonts.style.display = 'block';
      }
      if (paneStorage) {
        paneStorage.classList.add('hidden');
        paneStorage.style.display = 'none';
      }
    } else {
      if (btnTabFonts) btnTabFonts.classList.remove('active');
      if (btnTabStorage) btnTabStorage.classList.add('active');
      if (paneFonts) {
        paneFonts.classList.add('hidden');
        paneFonts.style.display = 'none';
      }
      if (paneStorage) {
        paneStorage.classList.remove('hidden');
        paneStorage.style.display = 'block';
      }
      refreshSystemStorageInfo();
    }
  };

  if (btnTabFonts) btnTabFonts.addEventListener('click', () => switchTab('fonts'));
  if (btnTabStorage) btnTabStorage.addEventListener('click', () => switchTab('storage'));

  // 2. Scan Local Installed Fonts
  const btnScanFonts = document.getElementById('btn-scan-fonts');
  const scannedWrapper = document.getElementById('scanned-fonts-wrapper');
  const scannedCount = document.getElementById('scanned-fonts-count');
  const scannedList = document.getElementById('scanned-fonts-list');
  let hasScannedFonts = false;

  const doScanFonts = async () => {
    if (btnScanFonts) {
      btnScanFonts.disabled = true;
      btnScanFonts.innerHTML = '⏳ 正在扫描系统字体...';
    }
    try {
      const res = await fetch('/api/system/fonts');
      const data = await res.json();
      if (data && data.installed) {
        if (scannedCount) scannedCount.textContent = data.installed_count || data.installed.length;
        if (scannedWrapper) {
          scannedWrapper.classList.remove('hidden');
          scannedWrapper.style.display = 'block';
        }
        if (scannedList) {
          scannedList.innerHTML = '';
          data.installed.forEach(font => {
            const chip = document.createElement('button');
            chip.className = 'font-chip';
            chip.type = 'button';
            chip.title = `点击复制字体名称：${font.name}`;
            chip.innerHTML = `<span>${escapeHtml(font.name)}</span>${font.file ? `<span class="font-chip-file">${escapeHtml(font.file)}</span>` : ''}`;
            chip.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(font.name);
                chip.classList.add('copied');
                const origHtml = chip.innerHTML;
                chip.innerHTML = `<span>✓ 已复制 ${escapeHtml(font.name)}</span>`;
                setTimeout(() => {
                  chip.innerHTML = origHtml;
                  chip.classList.remove('copied');
                }, 1200);
              } catch (err) {
                prompt('请按 Ctrl+C 复制字体名：', font.name);
              }
            });
            scannedList.appendChild(chip);
          });
        }
        if (btnScanFonts) btnScanFonts.innerHTML = '🔄 刷新扫描';
        hasScannedFonts = true;
      }
    } catch (err) {
      console.error('Scan fonts error:', err);
      if (btnScanFonts) btnScanFonts.innerHTML = '❌ 扫描失败，点击重试';
    } finally {
      if (btnScanFonts) btnScanFonts.disabled = false;
    }
  };

  if (btnScanFonts) {
    btnScanFonts.addEventListener('click', doScanFonts);
  }

  const openModal = async () => {
    modal.classList.remove('hidden');
    switchTab('fonts');
    await refreshSystemStorageInfo();
    if (!hasScannedFonts) {
      doScanFonts();
    }
  };

  const closeModal = () => {
    modal.classList.add('hidden');
  };

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnOk) btnOk.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 3. LaTeX Font Snippet Copy Buttons
  modal.querySelectorAll('.btn-copy-snippet').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.getAttribute('data-code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        const origText = btn.innerHTML;
        btn.innerHTML = '✓ 已复制';
        setTimeout(() => { btn.innerHTML = origText; }, 1500);
      } catch (err) {
        prompt('请按 Ctrl+C 复制以下代码：', code);
      }
    });
  });

  // 4. LaTeX Font Snippet Apply Buttons (Smart Preamble Injection & Recompile)
  function applyFontSnippetToDocument(code) {
    if (!editor) return;
    const content = editor.getValue();
    let newContent = content;

    if (code.startsWith('\\documentclass')) {
      if (/\\documentclass(\[[^\]]*\])?\{[^}]+\}/.test(content)) {
        newContent = content.replace(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/, code);
      } else {
        newContent = code + '\n' + content;
      }
    } else if (code.startsWith('\\setCJKmainfont')) {
      if (/\\setCJKmainfont\{[^}]+\}(\[[^\]]*\])?/.test(content)) {
        newContent = content.replace(/\\setCJKmainfont\{[^}]+\}(\[[^\]]*\])?/, code);
      } else {
        const match = content.match(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/);
        if (match) {
          const idx = match.index + match[0].length;
          newContent = content.slice(0, idx) + '\n' + code + content.slice(idx);
        } else {
          newContent = code + '\n' + content;
        }
      }
    } else {
      const doc = editor.getDoc ? editor.getDoc() : editor;
      if (doc.replaceSelection) {
        doc.replaceSelection(code + '\n');
      }
      return;
    }

    editor.setValue(newContent);
    // Auto-save to local disk and compile immediately
    saveContent();
    setTimeout(() => {
      triggerCompile(true);
    }, 120);
  }

  modal.querySelectorAll('.btn-apply-snippet, .btn-insert-snippet').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      if (!code) return;
      applyFontSnippetToDocument(code);
      const origHtml = btn.innerHTML;
      btn.innerHTML = '✓ 已应用并编译!';
      btn.style.backgroundColor = '#10b981';
      btn.style.color = '#ffffff';
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.style.backgroundColor = '';
        btn.style.color = '';
        closeModal();
      }, 700);
    });
  });

  // 5. Global Shortcuts: F2 or Ctrl+,
  window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    if (e.key === 'F2' || (isCtrl && e.key === ',')) {
      e.preventDefault();
      if (modal.classList.contains('hidden')) {
        openModal();
      } else {
        closeModal();
      }
    } else if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

// --- 9.5 Shortcuts Cheat Sheet Modal ---
function initShortcutsModal() {
  const modal = document.getElementById('modal-shortcuts');
  const btnOpen = document.getElementById('btn-shortcuts');
  const btnClose = document.getElementById('btn-close-shortcuts');
  const btnOk = document.getElementById('btn-ok-shortcuts');

  if (!modal) return;
  const openModal = () => modal.classList.remove('hidden');
  const closeModal = () => modal.classList.add('hidden');

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnOk) btnOk.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      if (modal.classList.contains('hidden')) {
        openModal();
      } else {
        closeModal();
      }
    } else if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

// --- 9. Exit Application Modal ---
function initExitModal() {
  const modal = document.getElementById('modal-exit');
  const btnOpen = document.getElementById('btn-exit-app');
  const btnClose = document.getElementById('btn-close-exit');
  const btnCancel = document.getElementById('btn-cancel-exit');
  const btnConfirm = document.getElementById('btn-confirm-exit');

  btnOpen.addEventListener('click', () => {
    modal.classList.remove('hidden');
  });

  const closeModal = () => modal.classList.add('hidden');
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = '正在保存并退出...';
    try {
      // Flush save first
      await saveContent();
      // Notify backend to cleanly shutdown and close Edge app window
      await fetch('/api/system/shutdown', { method: 'POST' });
    } catch (e) {}
    
    // Attempt browser window close
    window.close();

    // In case browser security policy prevents window.close(), display clean exit state
    setTimeout(() => {
      document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background-color:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
          <div style="font-size:52px;margin-bottom:18px;">👋</div>
          <h2 style="font-size:22px;font-weight:600;margin-bottom:8px;color:#38bdf8;">PaperLeaf 已安全退出</h2>
          <p style="color:#94a3b8;font-size:14px;margin-bottom:20px;">后台服务与进程已全部释放，所有代码均已完整保存至本地项目目录。</p>
          <div style="color:#64748b;font-size:12px;background:rgba(255,255,255,0.05);padding:6px 14px;border-radius:20px;">您可以安全关闭此窗口</div>
        </div>
      `;
    }, 250);
  });
}

// --- 10. File Tree Tab and Actions UI ---
function initFileTreeUI() {
  const tabFiletree = document.getElementById('tab-filetree');
  const tabProjects = document.getElementById('tab-projects');
  const viewFiletree = document.getElementById('view-filetree');
  const viewProjects = document.getElementById('view-projects');

  tabFiletree.addEventListener('click', () => {
    tabFiletree.classList.add('active');
    tabProjects.classList.remove('active');
    viewFiletree.classList.add('active');
    viewProjects.classList.remove('active');
    loadFileTree();
  });

  tabProjects.addEventListener('click', () => {
    tabProjects.classList.add('active');
    tabFiletree.classList.remove('active');
    viewProjects.classList.add('active');
    viewFiletree.classList.remove('active');
    loadProjects();
  });

  // Upload file / image button
  const btnTreeUpload = document.getElementById('btn-tree-upload');
  const inputTreeUpload = document.getElementById('input-tree-upload');
  if (btnTreeUpload && inputTreeUpload) {
    btnTreeUpload.addEventListener('click', () => {
      currentUploadTargetDir = ''; // Upload to project root
      inputTreeUpload.value = '';
      inputTreeUpload.click();
    });

    inputTreeUpload.addEventListener('change', async () => {
      if (inputTreeUpload.files && inputTreeUpload.files.length > 0) {
        await uploadFilesToProject(inputTreeUpload.files, currentUploadTargetDir);
        currentUploadTargetDir = '';
      }
    });
  }

  // Open folder in Windows Explorer
  const btnOpenFolder = document.getElementById('btn-tree-open-folder');
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      if (!currentProjectId) return;
      try {
        await fetch(`/api/projects/${currentProjectId}/open_folder`, { method: 'POST' });
      } catch (e) {
        console.error(e);
      }
    });
  }

  // New folder in project
  const btnNewFolder = document.getElementById('btn-tree-new-folder');
  if (btnNewFolder) {
    btnNewFolder.addEventListener('click', async () => {
      if (!currentProjectId) return;
      const folderName = prompt('请输入新文件夹名称（例如：figures、images、sections 等）：');
      if (!folderName || !folderName.trim()) return;
      try {
        const res = await fetch(`/api/projects/${currentProjectId}/create_file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderName.trim(), is_dir: true })
        });
        const data = await res.json();
        if (data.success) {
          await loadFileTree();
        } else {
          alert('创建文件夹失败: ' + data.error);
        }
      } catch (e) {
        alert('创建异常: ' + e);
      }
    });
  }

  // New file in project
  const btnNewFile = document.getElementById('btn-tree-new-file');
  if (btnNewFile) {
    btnNewFile.addEventListener('click', async () => {
      if (!currentProjectId) return;
      const fileName = prompt('请输入新文件名（例如：references.bib、chapter1.tex 等）：');
      if (!fileName || !fileName.trim()) return;
      try {
        const res = await fetch(`/api/projects/${currentProjectId}/create_file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fileName.trim() })
        });
        const data = await res.json();
        if (data.success) {
          await loadFileTree();
          await switchActiveFile(fileName.trim());
        } else {
          alert('创建文件失败: ' + data.error);
        }
      } catch (e) {
        alert('创建异常: ' + e);
      }
    });
  }

  // Drag and drop images/files onto the file tree
  const treeDropZone = document.getElementById('view-filetree');
  if (treeDropZone) {
    treeDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      treeDropZone.style.backgroundColor = 'rgba(56, 189, 248, 0.1)';
    });

    treeDropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      treeDropZone.style.backgroundColor = '';
    });

    treeDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      treeDropZone.style.backgroundColor = '';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        const isZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');
        if (isZip) {
          if (confirm(`检测到拖入 ZIP 压缩包【${files[0].name}】，是作为新工程导入(确定)，还是放入当前工程文件树(取消)？`)) {
            await uploadZipFile(files[0]);
            return;
          }
        }
        await uploadFilesToProject(files);
      }
    });
  }
}

function initMediaToolbar() {
  const btnCopy = document.getElementById('btn-media-copy-latex');
  const btnBack = document.getElementById('btn-media-back-code');
  const btnDownload = document.getElementById('btn-media-download');

  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      if (currentActiveFile) {
        downloadProjectFile(currentActiveFile);
      }
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      copyFigureCode(currentActiveFile);
    });
  }

  if (btnBack) {
    btnBack.addEventListener('click', () => {
      document.getElementById('media-preview-wrapper').classList.add('hidden');
      document.getElementById('editor-wrapper').style.display = 'block';
      switchActiveFile('main.tex');
      if (editor && editor.refresh) editor.refresh();
    });
  }
}

// --- 12. Productivity Suite (Formatting, Comment, Search, Word Count, SyncTeX, Theme, Font, Clean Export) ---

// 12.0 Academic Formatting Suite & Shortcuts (Ctrl+B, Ctrl+I, Ctrl+U, etc.)
function applyWrapCommand(cm, prefix, suffix, unwrapRegex) {
  if (!cm) return;
  const selection = cm.getSelection();

  if (selection.length > 0) {
    if (unwrapRegex && unwrapRegex.test(selection)) {
      const match = selection.match(unwrapRegex);
      cm.replaceSelection(match[1], 'around');
      cm.focus();
      return;
    }
    if (prefix && suffix && selection.startsWith(prefix) && selection.endsWith(suffix)) {
      const inner = selection.slice(prefix.length, selection.length - suffix.length);
      cm.replaceSelection(inner, 'around');
      cm.focus();
      return;
    }
    cm.replaceSelection(`${prefix}${selection}${suffix}`, 'around');
    cm.focus();
    return;
  }

  const cursor = cm.getCursor();
  cm.replaceRange(`${prefix}${suffix}`, cursor);
  cm.setCursor({ line: cursor.line, ch: cursor.ch + prefix.length });
  cm.focus();
}

function formatBold(cm) {
  applyWrapCommand(cm, '\\textbf{', '}', /^\\textbf\{([\s\S]*)\}$/);
}

function formatItalic(cm) {
  applyWrapCommand(cm, '\\textit{', '}', /^\\textit\{([\s\S]*)\}$/);
}

function formatUnderline(cm) {
  applyWrapCommand(cm, '\\underline{', '}', /^\\underline\{([\s\S]*)\}$/);
}

function formatCode(cm) {
  applyWrapCommand(cm, '\\texttt{', '}', /^\\texttt\{([\s\S]*)\}$/);
}

function formatInlineMath(cm) {
  applyWrapCommand(cm, '$', '$', /^\$([\s\S]*)\$$/);
}

function formatEquation(cm) {
  if (!cm) return;
  const sel = cm.getSelection();
  if (sel.length > 0) {
    cm.replaceSelection(`\\begin{equation}\n  ${sel.trim()}\n\\end{equation}`, 'around');
  } else {
    const cur = cm.getCursor();
    cm.replaceRange(`\\begin{equation}\n  \n\\end{equation}`, cur);
    cm.setCursor({ line: cur.line + 1, ch: 2 });
  }
  cm.focus();
}

function formatItemize(cm) {
  if (!cm) return;
  const sel = cm.getSelection();
  if (sel.length > 0) {
    const lines = sel.split('\n').filter(l => l.trim().length > 0);
    const items = lines.map(l => `  \\item ${l.trim()}`).join('\n');
    cm.replaceSelection(`\\begin{itemize}\n${items}\n\\end{itemize}`, 'around');
  } else {
    const cur = cm.getCursor();
    cm.replaceRange(`\\begin{itemize}\n  \\item \n\\end{itemize}`, cur);
    cm.setCursor({ line: cur.line + 1, ch: 8 });
  }
  cm.focus();
}

function formatEnumerate(cm) {
  if (!cm) return;
  const sel = cm.getSelection();
  if (sel.length > 0) {
    const lines = sel.split('\n').filter(l => l.trim().length > 0);
    const items = lines.map(l => `  \\item ${l.trim()}`).join('\n');
    cm.replaceSelection(`\\begin{enumerate}\n${items}\n\\end{enumerate}`, 'around');
  } else {
    const cur = cm.getCursor();
    cm.replaceRange(`\\begin{enumerate}\n  \\item \n\\end{enumerate}`, cur);
    cm.setCursor({ line: cur.line + 1, ch: 8 });
  }
  cm.focus();
}

function formatQuote(cm) {
  applyWrapCommand(cm, "``", "''", /^``([\s\S]*)''$/);
}

function formatBraces(cm) {
  applyWrapCommand(cm, '{', '}', /^\{([\s\S]*)\}$/);
}

function handleAutoSurround(cm, openChar, closeChar) {
  if (!cm) return false;
  const sel = cm.getSelection();
  if (sel && sel.length > 0) {
    cm.replaceSelection(`${openChar}${sel}${closeChar}`, 'around');
    return true;
  }
  return false;
}

function handleSmartEnter(cm) {
  if (!cm) return;
  const cur = cm.getCursor();
  const lineText = cm.getLine(cur.line);
  const match = lineText.match(/^(\s*)\\item\s*(.*)$/);

  if (match) {
    const indent = match[1];
    const content = match[2].trim();

    // If item line is empty, pressing Enter clears \item to exit list
    if (content === '') {
      cm.replaceRange('', { line: cur.line, ch: 0 }, { line: cur.line, ch: lineText.length });
      return;
    }

    if (cur.ch >= lineText.indexOf('\\item') + 5) {
      cm.replaceSelection(`\n${indent}\\item `, 'end');
      return;
    }
  }

  cm.execCommand('newlineAndIndent');
}

function initFormatToolbar() {
  const binds = [
    { id: 'fmt-bold', fn: () => formatBold(editor) },
    { id: 'fmt-italic', fn: () => formatItalic(editor) },
    { id: 'fmt-underline', fn: () => formatUnderline(editor) },
    { id: 'fmt-code', fn: () => formatCode(editor) },
    { id: 'fmt-math', fn: () => formatInlineMath(editor) },
    { id: 'fmt-equation', fn: () => formatEquation(editor) },
    { id: 'fmt-itemize', fn: () => formatItemize(editor) },
    { id: 'fmt-enumerate', fn: () => formatEnumerate(editor) },
    { id: 'fmt-quote', fn: () => formatQuote(editor) },
    { id: 'fmt-braces', fn: () => formatBraces(editor) }
  ];

  binds.forEach(b => {
    const el = document.getElementById(b.id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        b.fn();
      });
    }
  });
}

// --- 13. Real-Time Math Formula Preview (KaTeX Floating Tooltip) ---
let _mathPreviewTimer = null;

function sanitizeMathForKatex(rawMath, envName = null) {
  if (!rawMath) return '';
  let cleaned = rawMath
    .replace(/(^|[^\\])%.*$/gm, '$1')  // strip LaTeX comments
    .replace(/\\label\{[^}]*\}/g, '')  // strip \label{...}
    .replace(/\\nonumber/g, '')         // strip \nonumber
    .replace(/\\notag/g, '')            // strip \notag
    .trim();

  // If inside an alignment environment or contains alignment '&', wrap in aligned for KaTeX
  if ((envName && envName.startsWith('align')) || (cleaned.includes('&') && !cleaned.includes('\\begin{'))) {
    cleaned = '\\begin{aligned}\n' + cleaned + '\n\\end{aligned}';
  }
  return cleaned;
}

function detectMathAtCursor(cm) {
  if (!cm || typeof cm.getCursor !== 'function') return null;
  const cur = cm.getCursor();
  const lineIdx = cur.line;
  const ch = cur.ch;
  const curLine = cm.getLine(lineIdx);
  if (curLine === undefined) return null;

  // 1. Single-line / Multi-line environments (\begin{equation|align|...})
  const MATH_ENVS = ['equation', 'align', 'gather', 'multline', 'flalign', 'split', 'cases'];
  const startScan = Math.max(0, lineIdx - 40);
  let openEnv = null;
  let openLine = -1;
  let openCh = -1;

  for (let l = lineIdx; l >= startScan; l--) {
    const txt = cm.getLine(l);
    if (!txt) continue;
    let found = false;
    for (const env of MATH_ENVS) {
      const regBegin = new RegExp('\\\\begin\\{(' + env + '\\*?)\\}');
      const regEnd = new RegExp('\\\\end\\{(' + env + '\\*?)\\}');
      if (regEnd.test(txt) && l < lineIdx) {
        // Closed on a previous line before cursor
        found = true;
        break;
      }
      const mBegin = txt.match(regBegin);
      if (mBegin) {
        openEnv = mBegin[1];
        openLine = l;
        openCh = mBegin.index + mBegin[0].length;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (openEnv) {
    if (lineIdx > openLine || (lineIdx === openLine && ch >= openCh - openEnv.length - 8)) {
      let closeLine = -1;
      let closeCh = -1;
      const endScan = Math.min(cm.lineCount(), lineIdx + 40);
      for (let l = lineIdx; l < endScan; l++) {
        const txt = cm.getLine(l);
        if (!txt) continue;
        const regEnd = new RegExp('\\\\end\\{' + openEnv.replace('*', '\\*') + '\\}');
        const mEnd = txt.match(regEnd);
        if (mEnd) {
          closeLine = l;
          closeCh = mEnd.index;
          break;
        }
      }

      const endL = closeLine !== -1 ? closeLine : lineIdx;
      if (closeLine === -1 || lineIdx < closeLine || (lineIdx === closeLine && ch <= closeCh + openEnv.length + 6)) {
        const parts = [];
        for (let l = openLine; l <= endL; l++) {
          let lineStr = cm.getLine(l) || '';
          if (l === openLine) {
            const idx = lineStr.indexOf('\\begin{' + openEnv + '}');
            if (idx !== -1) lineStr = lineStr.slice(idx + openEnv.length + 8);
          }
          if (l === closeLine) {
            const idx = lineStr.indexOf('\\end{' + openEnv + '}');
            if (idx !== -1) lineStr = lineStr.slice(0, idx);
          }
          parts.push(lineStr);
        }
        return {
          math: parts.join('\n').trim(),
          isDisplay: true,
          type: 'environment',
          envName: openEnv
        };
      }
    }
  }

  // 2. Check for \[ ... \]
  if (curLine.includes('\\[')) {
    const idxB = curLine.indexOf('\\[');
    const idxE = curLine.indexOf('\\]', idxB + 2);
    if (idxE !== -1) {
      if (idxB <= ch && ch <= idxE + 2) {
        return {
          math: curLine.slice(idxB + 2, idxE).trim(),
          isDisplay: true,
          type: 'bracket'
        };
      }
    } else if (ch >= idxB) {
      return {
        math: curLine.slice(idxB + 2, ch).trim(),
        isDisplay: true,
        type: 'bracket'
      };
    }
  }

  // 3. Check for $...$ or $$...$$ on current line
  const dollars = [];
  for (let i = 0; i < curLine.length; i++) {
    if (curLine[i] === '$') {
      let k = i - 1;
      let bs = 0;
      while (k >= 0 && curLine[k] === '\\') {
        bs++;
        k--;
      }
      if (bs % 2 === 0) {
        dollars.push(i);
      }
    }
  }

  let idx = 0;
  while (idx < dollars.length) {
    const d1 = dollars[idx];
    const isDouble = (idx + 1 < dollars.length && dollars[idx + 1] === d1 + 1);
    const step1 = isDouble ? 2 : 1;

    let nextIdx = idx + step1;
    let foundClose = false;
    while (nextIdx < dollars.length) {
      const d2 = dollars[nextIdx];
      const isCloseDouble = (nextIdx + 1 < dollars.length && dollars[nextIdx + 1] === d2 + 1);
      const step2 = isCloseDouble ? 2 : 1;

      if (isDouble === isCloseDouble) {
        if (d1 <= ch && ch <= d2 + step2) {
          return {
            math: curLine.slice(d1 + step1, d2).trim(),
            isDisplay: isDouble,
            type: 'dollar'
          };
        }
        foundClose = true;
        idx = nextIdx + step2;
        break;
      }
      nextIdx += step2;
    }

    if (!foundClose) {
      // Unclosed delimiter on current line
      if (ch >= d1) {
        return {
          math: curLine.slice(d1 + step1, ch).trim(),
          isDisplay: isDouble,
          type: 'dollar'
        };
      }
      idx += step1;
    }
  }

  return null;
}

function renderKatexError(err, math, contentEl, statusEl) {
  const raw = err.rawMessage || err.message || '';
  const trimmed = math.trim();

  // 1. Incomplete \frac
  if (trimmed.includes('\\frac') && (raw.includes('Unexpected end of input') || raw.includes("expected '}'") || raw.includes('Expected group'))) {
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '输入中...';
    contentEl.innerHTML = '<span class="math-preview-pending"><span class="pending-icon">⏳</span> 等待输入分子与分母：\\frac{分子}{分母}</span>';
    return;
  }

  // 2. Incomplete \sqrt
  if (trimmed.includes('\\sqrt') && (raw.includes('Expected group') || raw.includes('Unexpected end of input'))) {
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '输入中...';
    contentEl.innerHTML = '<span class="math-preview-pending"><span class="pending-icon">⏳</span> 等待输入根式内容：\\sqrt{...}</span>';
    return;
  }

  // 3. User is actively typing a command name: ends with backslash or incomplete letters e.g. \al, \fr
  if (/\\[a-zA-Z]*$/.test(trimmed) && (raw.includes('Undefined control sequence') || raw.includes('Unexpected end of input'))) {
    const match = trimmed.match(/(\\[a-zA-Z]*)$/);
    const cmdPart = match ? match[1] : '\\';
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '输入中...';
    contentEl.innerHTML = `<span class="math-preview-pending"><span class="pending-icon">⏳</span> 正在输入命令：<code>${escapeHtml(cmdPart)}</code></span>`;
    return;
  }

  // 4. Unclosed curly brace
  if (raw.includes("Expected '}', got 'EOF'") || raw.includes("expected '}'")) {
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '输入中...';
    contentEl.innerHTML = '<span class="math-preview-pending"><span class="pending-icon">⏳</span> 公式未闭合：等待右花括号 \'}\'</span>';
    return;
  }

  // 5. Unclosed \left / \right
  if (raw.includes('\\right') || raw.includes('Expected \\right')) {
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '输入中...';
    contentEl.innerHTML = '<span class="math-preview-pending"><span class="pending-icon">⏳</span> 括号未闭合：等待 \\right 闭合</span>';
    return;
  }

  // 6. Unknown command
  if (raw.includes('Undefined control sequence')) {
    const match = raw.match(/Undefined control sequence:\s*(\\[a-zA-Z]+)/);
    const cmd = match ? match[1] : '';
    statusEl.className = 'math-preview-status error';
    statusEl.textContent = '语法提示';
    contentEl.innerHTML = `<span class="math-preview-error">⚠️ 未知的 LaTeX 命令：<code>${escapeHtml(cmd || trimmed)}</code></span>`;
    return;
  }

  // 7. Generic KaTeX error
  let friendly = raw.replace(/^KaTeX parse error:\s*/i, '');
  if (friendly.indexOf(' at position') !== -1) {
    friendly = friendly.split(' at position')[0];
  }
  if (friendly.indexOf(' at end of input') !== -1) {
    friendly = friendly.split(' at end of input')[0];
  }
  statusEl.className = 'math-preview-status error';
  statusEl.textContent = '语法提示';
  contentEl.innerHTML = `<span class="math-preview-error">⚠️ ${escapeHtml(friendly)}</span>`;
}

function positionMathTooltip(cm) {
  const tooltip = document.getElementById('math-preview-tooltip');
  if (!tooltip || tooltip.classList.contains('hidden') || !cm || typeof cm.cursorCoords !== 'function') return;

  if (document.body.classList.contains('mode-paper')) {
    hideMathTooltip();
    return;
  }

  const coords = cm.cursorCoords(true, 'window');
  if (!coords || (coords.top === 0 && coords.left === 0)) return;

  const editorWrapper = cm.getWrapperElement().getBoundingClientRect();

  // If cursor is scrolled outside visible editor box (with 35px tolerance)
  if (coords.bottom < editorWrapper.top - 35 || coords.top > editorWrapper.bottom + 35 ||
      coords.right < editorWrapper.left - 50 || coords.left > editorWrapper.right + 50) {
    tooltip.classList.add('hidden');
    return;
  }

  const tooltipWidth = tooltip.offsetWidth || 220;
  const tooltipHeight = tooltip.offsetHeight || 65;

  let top = coords.top - tooltipHeight - 10;
  let isBelow = false;

  // If clipping near format bar or top of window, flip below cursor
  if (top < editorWrapper.top + 5 || top < 50) {
    top = coords.bottom + 10;
    isBelow = true;
  }

  let left = coords.left - 24;
  const maxLeft = window.innerWidth - tooltipWidth - 20;
  if (left < 10) left = 10;
  if (left > maxLeft) left = maxLeft;

  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.left = `${Math.round(left)}px`;

  if (isBelow) {
    tooltip.classList.add('position-below');
  } else {
    tooltip.classList.remove('position-below');
  }

  const arrow = document.getElementById('math-preview-arrow');
  if (arrow) {
    const arrowLeft = Math.max(12, Math.min(tooltipWidth - 20, coords.left - left));
    arrow.style.left = `${Math.round(arrowLeft)}px`;
  }
}

function hideMathTooltip() {
  const tooltip = document.getElementById('math-preview-tooltip');
  if (tooltip) {
    tooltip.classList.add('hidden');
  }
}

function updateMathPreview(cm) {
  if (!cm || typeof cm.getCursor !== 'function' || typeof katex === 'undefined') return;
  if (document.body.classList.contains('mode-paper')) {
    hideMathTooltip();
    return;
  }

  const tooltip = document.getElementById('math-preview-tooltip');
  const contentEl = document.getElementById('math-preview-content');
  const statusEl = document.getElementById('math-preview-status');
  if (!tooltip || !contentEl || !statusEl) return;

  const mathInfo = detectMathAtCursor(cm);
  if (!mathInfo) {
    hideMathTooltip();
    return;
  }

  const { math, isDisplay, envName } = mathInfo;
  const cleanMath = sanitizeMathForKatex(math, envName);

  if (!cleanMath || cleanMath.length === 0) {
    statusEl.className = 'math-preview-status pending';
    statusEl.textContent = '待输入';
    contentEl.innerHTML = '<span class="math-preview-empty">输入 LaTeX 公式以实时预览...</span>';
  } else {
    try {
      const rendered = katex.renderToString(cleanMath, {
        throwOnError: true,
        displayMode: isDisplay
      });
      statusEl.className = 'math-preview-status ok';
      statusEl.textContent = '就绪';
      contentEl.innerHTML = rendered;
    } catch (err) {
      renderKatexError(err, cleanMath, contentEl, statusEl);
    }
  }

  tooltip.classList.remove('hidden');
  positionMathTooltip(cm);
}
window.updateMathPreview = updateMathPreview;

function scheduleMathPreviewUpdate(cm) {
  if (_mathPreviewTimer) clearTimeout(_mathPreviewTimer);
  _mathPreviewTimer = setTimeout(() => {
    updateMathPreview(cm);
  }, 40);
}

function initMathPreview(cm) {
  if (cm && typeof cm.getCursor === 'function') {
    scheduleMathPreviewUpdate(cm);
  }
}

// 12.1 Comment Toggle (Ctrl + /)
function toggleComment(cm) {
  if (!cm) return;
  const from = cm.getCursor('from');
  const to = cm.getCursor('to');
  const startLine = from.line;
  const endLine = to.line;
  
  let allCommented = true;
  let hasLines = false;
  for (let i = startLine; i <= endLine; i++) {
    const text = cm.getLine(i).trim();
    if (text.length > 0) {
      hasLines = true;
      if (!text.startsWith('%')) {
        allCommented = false;
        break;
      }
    }
  }
  if (!hasLines) allCommented = false;

  cm.operation(() => {
    for (let i = startLine; i <= endLine; i++) {
      const lineText = cm.getLine(i);
      if (allCommented) {
        const match = lineText.match(/^(\s*)%(?: )(.*)$/) || lineText.match(/^(\s*)%(.*)$/);
        if (match) {
          cm.replaceRange(match[1] + match[2], { line: i, ch: 0 }, { line: i, ch: lineText.length });
        }
      } else {
        cm.replaceRange('% ' + lineText, { line: i, ch: 0 }, { line: i, ch: lineText.length });
      }
    }
  });
}

// 12.2 Search & Replace (Ctrl + F, Ctrl + H)
let searchMarkers = [];
let searchMatches = [];
let currentMatchIdx = -1;
let isCaseSensitive = false;

function openSearchBar(showReplace = false) {
  const bar = document.getElementById('search-replace-bar');
  const replaceRow = document.getElementById('replace-row');
  const toggleBtn = document.getElementById('btn-toggle-replace');
  const searchInput = document.getElementById('search-input');
  
  if (!bar) return;

  const isAlreadyOpen = !bar.classList.contains('hidden');
  bar.classList.remove('hidden');

  if (showReplace) {
    if (replaceRow) replaceRow.classList.remove('hidden');
    if (toggleBtn) toggleBtn.classList.add('expanded');
  } else if (!isAlreadyOpen) {
    // If opening fresh via Ctrl+F, keep replace row hidden by default
    if (replaceRow) replaceRow.classList.add('hidden');
    if (toggleBtn) toggleBtn.classList.remove('expanded');
  }

  // If already open, or newly opened: check if editor has selection
  if (editor && typeof editor.getSelection === 'function') {
    const sel = editor.getSelection();
    if (sel && sel.length > 0 && sel.indexOf('\n') === -1 && searchInput) {
      searchInput.value = sel;
    }
  }

  if (searchInput) {
    searchInput.focus();
    searchInput.select();
  }
  performSearch();
}

function closeSearchBar() {
  const bar = document.getElementById('search-replace-bar');
  const replaceRow = document.getElementById('replace-row');
  const toggleBtn = document.getElementById('btn-toggle-replace');
  if (bar) bar.classList.add('hidden');
  if (replaceRow) replaceRow.classList.add('hidden');
  if (toggleBtn) toggleBtn.classList.remove('expanded');
  clearSearchMarkers();
  if (editor && typeof editor.focus === 'function') {
    editor.focus();
  }
}

function clearSearchMarkers() {
  searchMarkers.forEach(m => m.clear());
  searchMarkers = [];
  searchMatches = [];
  currentMatchIdx = -1;
  const countSpan = document.getElementById('search-match-count');
  if (countSpan) countSpan.textContent = '0 项';
}

function performSearch() {
  clearSearchMarkers();
  const searchInput = document.getElementById('search-input');
  const countSpan = document.getElementById('search-match-count');
  if (!searchInput || !editor || typeof editor.getValue !== 'function') return;

  const query = searchInput.value;
  if (!query) {
    if (countSpan) countSpan.textContent = '0 项';
    return;
  }

  const lineCount = editor.lineCount ? editor.lineCount() : 0;
  const queryLower = isCaseSensitive ? query : query.toLowerCase();

  for (let l = 0; l < lineCount; l++) {
    const lineText = editor.getLine(l);
    const textToSearch = isCaseSensitive ? lineText : lineText.toLowerCase();
    let idx = 0;
    while ((idx = textToSearch.indexOf(queryLower, idx)) !== -1) {
      const from = { line: l, ch: idx };
      const to = { line: l, ch: idx + query.length };
      const marker = editor.markText(from, to, { className: 'cm-searching' });
      searchMarkers.push(marker);
      searchMatches.push({ from, to });
      idx += query.length;
    }
  }

  if (searchMatches.length > 0) {
    currentMatchIdx = 0;
    highlightCurrentMatch();
  } else {
    if (countSpan) countSpan.textContent = '无匹配';
  }
}

function highlightCurrentMatch() {
  const countSpan = document.getElementById('search-match-count');
  if (currentMatchIdx < 0 || currentMatchIdx >= searchMatches.length) {
    if (countSpan) countSpan.textContent = '无匹配';
    return;
  }

  const match = searchMatches[currentMatchIdx];
  if (countSpan) {
    countSpan.textContent = (currentMatchIdx + 1) + ' / ' + searchMatches.length;
  }

  editor.setSelection(match.from, match.to);
  editor.scrollIntoView(match.from, 80);
}

function jumpMatch(delta) {
  if (searchMatches.length === 0) return;
  currentMatchIdx = (currentMatchIdx + delta + searchMatches.length) % searchMatches.length;
  highlightCurrentMatch();
}

function replaceCurrentMatch() {
  if (currentMatchIdx < 0 || currentMatchIdx >= searchMatches.length) return;
  const replaceInput = document.getElementById('replace-input');
  const replaceText = replaceInput ? replaceInput.value : '';
  const match = searchMatches[currentMatchIdx];

  editor.replaceRange(replaceText, match.from, match.to);
  performSearch();
}

function replaceAllMatches() {
  if (searchMatches.length === 0) return;
  const replaceInput = document.getElementById('replace-input');
  const replaceText = replaceInput ? replaceInput.value : '';
  const count = searchMatches.length;

  editor.operation(() => {
    for (let i = searchMatches.length - 1; i >= 0; i--) {
      const m = searchMatches[i];
      editor.replaceRange(replaceText, m.from, m.to);
    }
  });

  performSearch();
  setCompileStatus('idle', '已完成替换 ' + count + ' 处匹配项');
}

function initSearchAndReplace() {
  const btnOpen = document.getElementById('btn-open-search');
  const btnClose = document.getElementById('btn-search-close');
  const btnPrev = document.getElementById('btn-search-prev');
  const btnNext = document.getElementById('btn-search-next');
  const btnCase = document.getElementById('btn-search-case');
  const btnToggleReplace = document.getElementById('btn-toggle-replace');
  const btnReplaceOne = document.getElementById('btn-replace-one');
  const btnReplaceAll = document.getElementById('btn-replace-all');
  const searchInput = document.getElementById('search-input');
  const replaceInput = document.getElementById('replace-input');
  const replaceRow = document.getElementById('replace-row');

  if (btnOpen) btnOpen.addEventListener('click', () => openSearchBar(false));
  if (btnClose) btnClose.addEventListener('click', closeSearchBar);

  if (btnToggleReplace && replaceRow) {
    btnToggleReplace.addEventListener('click', () => {
      const isHidden = replaceRow.classList.toggle('hidden');
      btnToggleReplace.classList.toggle('expanded', !isHidden);
      if (!isHidden && replaceInput) replaceInput.focus();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => performSearch());
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) jumpMatch(-1);
        else jumpMatch(1);
      } else if (e.key === 'Escape') {
        closeSearchBar();
      }
    });
  }

  if (replaceInput) {
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceCurrentMatch();
      } else if (e.key === 'Escape') {
        closeSearchBar();
      }
    });
  }

  if (btnPrev) btnPrev.addEventListener('click', () => jumpMatch(-1));
  if (btnNext) btnNext.addEventListener('click', () => jumpMatch(1));

  if (btnCase) {
    btnCase.addEventListener('click', () => {
      isCaseSensitive = !isCaseSensitive;
      btnCase.classList.toggle('active', isCaseSensitive);
      performSearch();
    });
  }

  if (btnReplaceOne) btnReplaceOne.addEventListener('click', replaceCurrentMatch);
  if (btnReplaceAll) btnReplaceAll.addEventListener('click', replaceAllMatches);
}

// 12.3 Academic LaTeX Word & Element Count
function calculateWordCount() {
  if (!editor || typeof editor.getValue !== 'function') return;
  const content = editor.getValue();

  const totalLines = content.split('\n').length;
  const blockMath = (content.match(/\\begin\{(?:equation|align|gather|multline)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline)\*?\}/g) || []).length;
  const doubleDollar = (content.match(/\$\$[\s\S]+?\$\$/g) || []).length;
  const inlineMath = (content.match(/\$[^$\n]+?\$/g) || []).length;
  const totalMath = blockMath + doubleDollar + inlineMath;

  const totalFloats = (content.match(/\\begin\{(?:figure|table)\*?\}/g) || []).length;

  let totalCites = 0;
  const citeMatches = content.match(/\\cite[a-zA-Z]*\{([^}]+)\}/g);
  if (citeMatches) {
    citeMatches.forEach(c => {
      const keys = c.replace(/^[^\{]+\{/, '').replace(/\}$/, '').split(',');
      totalCites += keys.filter(k => k.trim().length > 0).length;
    });
  }

  let text = content.replace(/%[^\n]*/g, '');
  text = text.replace(/\\begin\{(?:equation|align|gather|multline)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline)\*?\}/g, ' ');
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  text = text.replace(/\$[^$\n]*?\$/g, ' ');
  text = text.replace(/\\[a-zA-Z]+(?:\*|\+)?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' ');
  text = text.replace(/[{}\/\\_\^~&]/g, ' ');

  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const wordsOnly = text.replace(/[\u4e00-\u9fa5]/g, ' ');
  const englishWords = (wordsOnly.match(/[a-zA-Z0-9_\-]+/g) || []).length;

  document.getElementById('stat-words').textContent = englishWords.toLocaleString();
  document.getElementById('stat-chars').textContent = chineseChars.toLocaleString();
  document.getElementById('stat-math').textContent = totalMath.toLocaleString();
  document.getElementById('stat-floats').textContent = totalFloats.toLocaleString();
  document.getElementById('stat-cites').textContent = totalCites.toLocaleString();
  document.getElementById('stat-lines').textContent = totalLines.toLocaleString();

  const modal = document.getElementById('modal-word-count');
  if (modal) modal.classList.remove('hidden');
}

function initWordCount() {
  const btnOpen = document.getElementById('btn-word-count');
  const modal = document.getElementById('modal-word-count');
  const btnClose = document.getElementById('btn-close-word-count');
  const btnOk = document.getElementById('btn-ok-word-count');

  if (btnOpen) btnOpen.addEventListener('click', calculateWordCount);
  if (btnClose) btnClose.addEventListener('click', () => modal.classList.add('hidden'));
  if (btnOk) btnOk.addEventListener('click', () => modal.classList.add('hidden'));
}

// 12.4 Overleaf-Grade Bidirectional SyncTeX
let _lastSyncForwardTime = 0;
async function triggerSyncTeXForward(targetLine = null) {
  const now = Date.now();
  if (now - _lastSyncForwardTime < 250) return;
  _lastSyncForwardTime = now;

  if (!currentProjectId || !editor) return;
  let lineNo = targetLine;
  if (lineNo === null || lineNo === undefined) {
    if (typeof editor.getCursor === 'function') {
      lineNo = (editor.somethingSelected && editor.somethingSelected())
        ? editor.getCursor('from').line + 1
        : editor.getCursor().line + 1;
    } else {
      lineNo = 1;
    }
  }
  const fileName = currentActiveFile || 'main.tex';

  setCompileStatus('idle', '🎯 正在同步定位第 ' + lineNo + ' 行...');

  try {
    const res = await fetch('/api/projects/' + currentProjectId + '/synctex/forward?file=' + encodeURIComponent(fileName) + '&line=' + lineNo);
    const data = await res.json();
    if (data.success && data.page) {
      highlightPdfRegion(data.page, data.x, data.y, data.w, data.h);
      setCompileStatus('idle', '🎯 已精准定位至第 ' + data.page + ' 页 (源码第 ' + lineNo + ' 行)');
    } else {
      setCompileStatus('idle', '未找到对应定位点 (建议重新编译生成最新索引)');
    }
  } catch (err) {
    setCompileStatus('idle', '定位失败');
  }
}

function highlightPdfRegion(pageNo, x, y, w, h) {
  const pageDiv = document.getElementById('pdf-page-' + pageNo);
  if (!pageDiv || !pdfContainer) return;

  const effScale = parseFloat(pageDiv.dataset.scale) || pdfScale;

  // 1. Calculate exact vertical pixel position of target line within pdfContainer scroll space
  const containerRect = pdfContainer.getBoundingClientRect();
  const pageRect = pageDiv.getBoundingClientRect();
  const pageTopInScroll = (pageRect.top - containerRect.top) + pdfContainer.scrollTop;
  const targetYInPage = Math.max(0, y * effScale);
  const targetAbsoluteY = pageTopInScroll + targetYInPage;

  // Center the target line vertically in the visible PDF viewport (around 1/3 ~ 1/2 from top)
  const targetScrollTop = targetAbsoluteY - (containerRect.height / 3);
  pdfContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });

  // 2. Clear previous pulse highlights
  document.querySelectorAll('.synctex-highlight-box').forEach(el => el.remove());

  const overlay = pageDiv.querySelector('.pdf-highlight-overlay');
  if (!overlay) return;

  const box = document.createElement('div');
  box.className = 'synctex-highlight-box';

  const lineH = (h && h > 0) ? h : 14;
  const lineW = (w && w > 0) ? w : 120;

  // In SyncTeX, y is the baseline in pt. The bounding box top is at approx (y - lineH * 0.85).
  const boxTop = Math.max(0, (y - lineH * 0.85) * effScale);
  const boxLeft = Math.max(0, (x - 6) * effScale);
  const boxWidth = Math.max(80, (lineW + 12) * effScale);
  const boxHeight = Math.max(16, (lineH + 4) * effScale);

  box.style.left = boxLeft + 'px';
  box.style.top = boxTop + 'px';
  box.style.width = boxWidth + 'px';
  box.style.height = boxHeight + 'px';

  overlay.appendChild(box);

  setTimeout(() => {
    if (box.parentNode) box.remove();
  }, 2400);
}

let _lastSyncBackwardTime = 0;
async function triggerSyncTeXBackward(pageNo, ptX, ptY) {
  const now = Date.now();
  if (now - _lastSyncBackwardTime < 250) return;
  _lastSyncBackwardTime = now;

  if (!currentProjectId || !editor) return;

  try {
    const res = await fetch('/api/projects/' + currentProjectId + '/synctex/backward?page=' + pageNo + '&x=' + ptX.toFixed(1) + '&y=' + ptY.toFixed(1));
    const data = await res.json();
    if (data.success && data.line) {
      // If target file is different from currentActiveFile, switch to it
      if (data.file && data.file !== currentActiveFile) {
        const fileItem = document.querySelector(`.tree-item[data-path="${data.file}"]`);
        if (fileItem) fileItem.click();
      }

      const lineIdx = Math.max(0, data.line - 1);
      if (typeof editor.setCursor === 'function') {
        editor.setCursor({ line: lineIdx, ch: 0 });
        editor.scrollIntoView({ line: lineIdx, ch: 0 }, 140);
        editor.focus();

        // Flash highlight on the source line in CodeMirror
        editor.addLineClass(lineIdx, 'background', 'cm-synctex-active-line');
        setTimeout(() => {
          editor.removeLineClass(lineIdx, 'background', 'cm-synctex-active-line');
        }, 1800);
      }

      setCompileStatus('idle', '🎯 已跳转至源码 ' + (data.file || 'main.tex') + ' 第 ' + data.line + ' 行');
    }
  } catch (err) {
    console.error('Backward SyncTeX error:', err);
  }
}

function jumpFromPdfToCode() {
  if (!currentProjectId || !editor || !pdfContainer) return;

  // 1. Check if user selected text anywhere in PDF TextLayer
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const selRect = range.getBoundingClientRect();
    if (selRect.width > 0 && selRect.height > 0) {
      let pageWrapper = null;
      if (range.commonAncestorContainer) {
        pageWrapper = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer.closest('.pdf-page-wrapper')
          : (range.commonAncestorContainer.parentElement ? range.commonAncestorContainer.parentElement.closest('.pdf-page-wrapper') : null);
      }

      if (!pageWrapper) {
        const pages = pdfContainer.querySelectorAll('.pdf-page-wrapper');
        for (const p of pages) {
          const pRect = p.getBoundingClientRect();
          if (selRect.top >= pRect.top - 10 && selRect.bottom <= pRect.bottom + 10) {
            pageWrapper = p;
            break;
          }
        }
      }

      if (pageWrapper) {
        const pRect = pageWrapper.getBoundingClientRect();
        const pageNum = parseInt(pageWrapper.dataset.page || '1', 10);
        const effScale = parseFloat(pageWrapper.dataset.scale) || pdfScale;
        const ptX = (selRect.left - pRect.left + selRect.width / 2) / effScale;
        const ptY = (selRect.top - pRect.top + selRect.height / 2) / effScale;
        triggerSyncTeXBackward(pageNum, ptX, ptY);
        return;
      }
    }
  }

  // 2. No selection: Jump from current visible viewport center in PDF
  const containerRect = pdfContainer.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 3;
  const pages = pdfContainer.querySelectorAll('.pdf-page-wrapper');
  for (const p of pages) {
    const pRect = p.getBoundingClientRect();
    if (pRect.top <= centerY && pRect.bottom >= centerY) {
      const pageNum = parseInt(p.dataset.page || '1', 10);
      const effScale = parseFloat(p.dataset.scale) || pdfScale;
      const ptX = 100;
      const ptY = Math.max(0, (centerY - pRect.top) / effScale);
      triggerSyncTeXBackward(pageNum, ptX, ptY);
      return;
    }
  }

  // Fallback to first page
  triggerSyncTeXBackward(1, 100, 100);
}

function initSyncTeX() {
  const btnSync = document.getElementById('btn-synctex-forward');
  if (btnSync) {
    btnSync.addEventListener('click', () => triggerSyncTeXForward());
  }

  const btnToPdf = document.getElementById('btn-synctex-to-pdf');
  const btnToCode = document.getElementById('btn-synctex-to-code');

  if (btnToPdf) {
    btnToPdf.addEventListener('mousedown', (e) => e.stopPropagation());
    btnToPdf.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      let targetLine = null;
      if (editor && typeof editor.getCursor === 'function') {
        targetLine = (editor.somethingSelected && editor.somethingSelected())
          ? editor.getCursor('from').line + 1
          : editor.getCursor().line + 1;
      }
      triggerSyncTeXForward(targetLine);
    });
  }

  if (btnToCode) {
    btnToCode.addEventListener('mousedown', (e) => e.stopPropagation());
    btnToCode.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpFromPdfToCode();
    });
  }
}

// 12.5 Theme Management (Dark / Light Mode)
function initTheme() {
  const urlParams = new URLSearchParams(window.location.search);
  const themeParam = urlParams.get('theme');
  const savedTheme = (themeParam === 'dark' || themeParam === 'light') ? themeParam : (localStorage.getItem('paperleaf_theme') || localStorage.getItem('localoverleaf_theme') || 'light');
  applyTheme(savedTheme);

  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('paperleaf_theme', next);
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  if (editor && typeof editor.refresh === 'function') {
    editor.refresh();
  }
}

// 12.6 Font Sizing (A- / A+)
let currentFontSize = parseInt(localStorage.getItem('paperleaf_font_size') || localStorage.getItem('localoverleaf_font_size') || '14', 10);

function initFontSize() {
  applyFontSize(currentFontSize);

  const btnDec = document.getElementById('btn-font-dec');
  const btnInc = document.getElementById('btn-font-inc');

  if (btnDec) {
    btnDec.addEventListener('click', () => {
      if (currentFontSize > 11) {
        currentFontSize -= 1;
        applyFontSize(currentFontSize);
        localStorage.setItem('paperleaf_font_size', currentFontSize);
      }
    });
  }

  if (btnInc) {
    btnInc.addEventListener('click', () => {
      if (currentFontSize < 24) {
        currentFontSize += 1;
        applyFontSize(currentFontSize);
        localStorage.setItem('paperleaf_font_size', currentFontSize);
      }
    });
  }
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--editor-font-size', size + 'px');
  const label = document.getElementById('font-size-label');
  if (label) {
    label.textContent = size + 'px';
  }
  if (editor && typeof editor.refresh === 'function') {
    editor.refresh();
  }
}

// 12.7 Clean Export Modal
function initExportModal() {
  const btnExport = document.getElementById('btn-export-zip');
  const modalExport = document.getElementById('modal-export');
  const btnClose = document.getElementById('btn-close-export');
  const btnCancel = document.getElementById('btn-cancel-export');
  const btnConfirm = document.getElementById('btn-confirm-export');
  const optClean = document.getElementById('opt-export-clean');
  const optFull = document.getElementById('opt-export-full');

  let exportType = 'clean';

  if (btnExport && modalExport) {
    btnExport.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentProjectId) {
        alert('请先选择一个项目进行导出');
        return;
      }
      modalExport.classList.remove('hidden');
    });
  }

  if (btnClose) btnClose.addEventListener('click', () => modalExport.classList.add('hidden'));
  if (btnCancel) btnCancel.addEventListener('click', () => modalExport.classList.add('hidden'));

  if (optClean && optFull) {
    optClean.addEventListener('click', () => {
      exportType = 'clean';
      optClean.classList.add('selected');
      optFull.classList.remove('selected');
    });
    optFull.addEventListener('click', () => {
      exportType = 'full';
      optFull.classList.add('selected');
      optClean.classList.remove('selected');
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', () => {
      modalExport.classList.add('hidden');
      const cleanParam = exportType === 'clean' ? '?clean=true' : '';
      window.location.href = '/api/projects/' + currentProjectId + '/export_zip' + cleanParam;
    });
  }
}

// --- 14. Smart Diagnostics & Quick Fix (Author Choice System) ---
const dismissedDiagnostics = new Set();
let _activeDiagnostic = null;

function showDiagnosticBanner(diag) {
  if (!diag) return;
  const key = `${currentProjectId}:${diag.id}`;
  if (dismissedDiagnostics.has(key)) {
    hideDiagnosticBanner();
    return;
  }
  _activeDiagnostic = { source: 'user', ...diag };
  const banner = document.getElementById('smart-diagnostic-banner');
  const titleEl = document.getElementById('diagnostic-banner-title');
  const descEl = document.getElementById('diagnostic-banner-desc');
  const applyBtn = document.getElementById('btn-diagnostic-apply');
  const ignoreBtn = document.getElementById('btn-diagnostic-ignore');
  const iconEl = document.getElementById('diagnostic-banner-icon');

  if (banner && titleEl && descEl && applyBtn) {
    if (iconEl) iconEl.textContent = diag.icon || '💡';
    titleEl.textContent = diag.title || '排版智能建议';
    descEl.textContent = diag.description || '';
    applyBtn.textContent = diag.action_label || '一键修复';
    if (ignoreBtn) {
      ignoreBtn.textContent = diag.ignore_label || '保留现状';
    }
    banner.classList.remove('hidden');
  }
}

function hideDiagnosticBanner() {
  _activeDiagnostic = null;
  const banner = document.getElementById('smart-diagnostic-banner');
  if (banner) {
    banner.classList.add('hidden');
  }
}

function applyDiagnosticAction() {
  const diag = _activeDiagnostic;
  if (!diag || !editor) return;

  if (diag.action === 'comment_ctex') {
    editor.operation(() => {
      const lineCount = editor.lineCount();
      for (let i = 0; i < lineCount; i++) {
        const line = editor.getLine(i);
        const trimmed = line.trim();
        if (trimmed.startsWith('%')) continue;

        // 1. \usepackage[...]{ctex} -> % \usepackage[...]{ctex}
        if (/\\usepackage(\[[^\]]*\])?\{ctex\}/.test(line)) {
          editor.replaceRange('% ' + line, { line: i, ch: 0 }, { line: i, ch: line.length });
        }
        // 2. \documentclass[...]{ctexart|ctexrep|ctexbook} -> % \documentclass... \n \documentclass{article}
        else if (/\\documentclass(\[[^\]]*\])?\{ctex(art|rep|book)\}/.test(line)) {
          const match = line.match(/\\documentclass(?:\[[^\]]*\])?\{ctex(art|rep|book)\}/);
          const stdType = match[1] === 'art' ? 'article' : (match[1] === 'rep' ? 'report' : 'book');
          const newLine = `% ${line}\n\\documentclass{${stdType}}`;
          editor.replaceRange(newLine, { line: i, ch: 0 }, { line: i, ch: line.length });
        }
      }
    });
    editor.focus();
    hideDiagnosticBanner();
    triggerCompile(true);
    return;
  }

  if (diag.action === 'uncomment_ctex') {
    editor.operation(() => {
      const lineCount = editor.lineCount();
      for (let i = 0; i < lineCount; i++) {
        const line = editor.getLine(i);
        const trimmed = line.trim();
        if (trimmed.startsWith('%') && /\\usepackage(\[[^\]]*\])?\{ctex\}/.test(line)) {
          const uncomm = line.replace(/^\s*%\s*/, '');
          editor.replaceRange(uncomm, { line: i, ch: 0 }, { line: i, ch: line.length });
        } else if (trimmed.startsWith('%') && /\\documentclass(\[[^\]]*\])?\{ctex(art|rep|book)\}/.test(line)) {
          const uncomm = line.replace(/^\s*%\s*/, '');
          if (i + 1 < editor.lineCount()) {
            const nextLine = editor.getLine(i + 1).trim();
            if (/^\\documentclass\{(article|report|book)\}$/.test(nextLine)) {
              editor.replaceRange('', { line: i + 1, ch: 0 }, { line: i + 2, ch: 0 });
            }
          }
          editor.replaceRange(uncomm, { line: i, ch: 0 }, { line: i, ch: line.length });
        }
      }
    });
    editor.focus();
    hideDiagnosticBanner();
    triggerCompile(true);
    return;
  }

  if (diag.action === 'insert_package' && diag.package_code) {
    const code = editor.getValue();
    const pkg = diag.package_code;

    // Check if package is already in editor
    if (!code.includes(pkg) && !code.includes('fontenc')) {
      const match = code.match(/(\\documentclass(?:\[[^\]]*\])?\{[^\}]+\})/);
      if (match) {
        const idx = code.indexOf(match[0]);
        const endLineIdx = code.indexOf('\n', idx);
        const insertPos = endLineIdx !== -1 ? endLineIdx + 1 : idx + match[0].length;
        const cmPos = editor.posFromIndex(insertPos);
        editor.replaceRange(pkg + '\n', cmPos);
      } else {
        editor.replaceRange(pkg + '\n', { line: 0, ch: 0 });
      }
      editor.focus();
    }

    hideDiagnosticBanner();
    triggerCompile(true);
  }
}

function ignoreDiagnostic() {
  const diag = _activeDiagnostic;
  if (diag && diag.id) {
    dismissedDiagnostics.add(`${currentProjectId}:${diag.id}`);
  }
  hideDiagnosticBanner();
}

function initDiagnosticBanner() {
  const applyBtn = document.getElementById('btn-diagnostic-apply');
  const ignoreBtn = document.getElementById('btn-diagnostic-ignore');
  const closeBtn = document.getElementById('btn-diagnostic-close');

  if (applyBtn) applyBtn.addEventListener('click', applyDiagnosticAction);
  if (ignoreBtn) ignoreBtn.addEventListener('click', ignoreDiagnostic);
  if (closeBtn) closeBtn.addEventListener('click', ignoreDiagnostic);
}

// --- Project Language Switcher Dropdown ---
function updateLangDropdownChecks(currentLang) {
  const checkCn = document.getElementById('check-chinese');
  const checkEn = document.getElementById('check-english');
  const itemCn = document.getElementById('item-lang-chinese');
  const itemEn = document.getElementById('item-lang-english');
  const isCn = currentLang === 'chinese';

  if (checkCn) checkCn.style.display = isCn ? 'inline' : 'none';
  if (checkEn) checkEn.style.display = isCn ? 'none' : 'inline';
  if (itemCn) itemCn.classList.toggle('active', isCn);
  if (itemEn) itemEn.classList.toggle('active', !isCn);
}

function initProjectLanguageSwitcher() {
  const dropdown = document.getElementById('project-lang-dropdown');
  const btnTrigger = document.getElementById('current-project-lang');
  const menu = document.getElementById('project-lang-menu');
  if (!dropdown || !btnTrigger || !menu) return;

  btnTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
      menu.classList.remove('hidden');
      dropdown.classList.add('open');
    } else {
      menu.classList.add('hidden');
      dropdown.classList.remove('open');
    }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      menu.classList.add('hidden');
      dropdown.classList.remove('open');
    }
  });

  menu.querySelectorAll('.lang-menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const targetLang = item.getAttribute('data-lang');
      menu.classList.add('hidden');
      dropdown.classList.remove('open');
      
      if (!currentProjectId || !currentProjectMeta) return;
      if (currentProjectMeta.language === targetLang) return;

      try {
        const res = await fetch(`/api/projects/${currentProjectId}/set_language`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: targetLang })
        });
        const data = await res.json();
        if (data.success) {
          currentProjectMeta.language = targetLang;
          const langText = document.getElementById('current-project-lang-text');
          const isCn = targetLang === 'chinese';
          if (langText) {
            langText.textContent = isCn ? '🇨🇳 中文 (CTeX)' : '🇬🇧 英文 (Standard)';
          }
          updateLangDropdownChecks(targetLang);

          // Smart diagnostic check: If switched to English and editor has active ctex
          if (targetLang === 'english' && editor) {
            dismissedDiagnostics.delete(`${currentProjectId}:suggest_comment_ctex`);
            const code = editor.getValue();
            const lines = code.split('\n');
            const hasActiveCtex = lines.some(l => {
              const t = l.trim();
              return !t.startsWith('%') && (/\\usepackage(\[[^\]]*\])?\{ctex\}/.test(l) || /\\documentclass(\[[^\]]*\])?\{ctex(art|rep|book)\}/.test(l));
            });

            if (hasActiveCtex) {
              showDiagnosticBanner({
                id: 'suggest_comment_ctex',
                source: 'user',
                icon: '🇬🇧',
                title: '国际学术期刊排版建议',
                description: '检测到当前工程已切换为英文，但代码中包含 CTeX 中文宏包。投递国外学术会议/期刊（如 IEEE/ACM/Nature）时可能因缺少中文字体而报错。',
                action: 'comment_ctex',
                action_label: '一键注释 CTeX 宏包',
                ignore_label: '保留现状'
              });
            } else {
              hideDiagnosticBanner();
            }
          }

          // Smart diagnostic check: If switched to Chinese but editor has no active ctex/CJK
          if (targetLang === 'chinese' && editor) {
            dismissedDiagnostics.delete(`${currentProjectId}:suggest_chinese_ctex`);
            const code = editor.getValue();
            const lines = code.split('\n');
            const hasActiveCtex = lines.some(l => {
              const t = l.trim();
              return !t.startsWith('%') && (/ctex/.test(l) || /xeCJK/.test(l));
            });

            if (!hasActiveCtex) {
              const hasCommentedCtex = lines.some(l => {
                const t = l.trim();
                return t.startsWith('%') && /ctex/.test(l);
              });

              if (hasCommentedCtex) {
                showDiagnosticBanner({
                  id: 'suggest_chinese_ctex',
                  source: 'user',
                  icon: '🇨🇳',
                  title: '中文排版建议：CTeX 宏包当前处于注释状态',
                  description: '检测到代码中存在已注释的 CTeX 宏包。若需在中文环境下正常排版，建议一键恢复启用。',
                  action: 'uncomment_ctex',
                  action_label: '一键取消注释 (启用 CTeX)',
                  ignore_label: '保留现状'
                });
              } else {
                showDiagnosticBanner({
                  id: 'suggest_chinese_ctex',
                  source: 'user',
                  icon: '🇨🇳',
                  title: '排版建议：当前工程已设为中文，尚未引入中文宏包',
                  description: '检测到主文档尚未引入 CTeX 宏包，中文可能无法正常渲染。建议在导言区引入 CTeX 宏包原生调用系统宋体/黑体。',
                  action: 'insert_package',
                  package_code: '\\usepackage{ctex}',
                  action_label: '一键添加中文支持 (CTeX)',
                  ignore_label: '保留现状'
                });
              }
            } else {
              hideDiagnosticBanner();
            }
          }
          
          triggerCompile(true);
        }
      } catch (err) {
        console.error('Failed to update project language:', err);
      }
    });
  });
}

// --- 11. Event Bindings ---
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initFontSize();
  initSearchAndReplace();
  initWordCount();
  initSyncTeX();
  initPdfControls();
  initExportModal();
  initFormatToolbar();
  initDiagnosticBanner();
  initProjectLanguageSwitcher();

  initEditor();
  initMathPreview(editor);
  initSplitters();
  applySplitRatio();
  initOutlineResizer();
  initMediaToolbar();
  initProjectModal();
  initStorageModal();
  initShortcutsModal();
  initExitModal();
  initZipFeatures();
  initFileTreeUI();
  startHeartbeat();

  // --- Responsive Drawer Snap & Window Resize Handling ---
  let autoCollapsedBySnap = false;
  let lastIsNarrow = null;
  let pdfResizeDebounceTimer = null;

  function checkResponsiveDrawerSnap(isInitial = false) {
    const availWidth = (window.screen && window.screen.availWidth) ? window.screen.availWidth : (window.innerWidth || 1920);
    const ratio = window.innerWidth / availWidth;

    // Half-screen snap is typically ratio ~ 0.50 (e.g. 960/1920 on 1080p, 1280/2560 on 2K).
    // Narrow/Snap condition: ratio <= 0.55 OR viewport width < 1020px
    const isNarrow = ratio <= 0.55 || window.innerWidth < 1020;
    // Wide condition: ratio >= 0.58 AND viewport width >= 1060px (deadband prevents chatter)
    const isWide = ratio >= 0.58 && window.innerWidth >= 1060;

    if (isInitial) {
      lastIsNarrow = isNarrow;
      if (isNarrow && !document.body.classList.contains('drawer-collapsed')) {
        document.body.classList.add('drawer-collapsed');
        autoCollapsedBySnap = true;
        applySplitRatio();
        if (editor && editor.refresh) {
          setTimeout(() => editor.refresh(), 50);
          setTimeout(() => editor.refresh(), 200);
        }
      }
      return;
    }

    if (isNarrow && !lastIsNarrow) {
      // Transitioned from Wide to Narrow (e.g. snapped to side or shrunk window)
      lastIsNarrow = true;
      if (!document.body.classList.contains('drawer-collapsed')) {
        document.body.classList.add('drawer-collapsed');
        autoCollapsedBySnap = true;
        applySplitRatio();
        if (editor && editor.refresh) {
          setTimeout(() => editor.refresh(), 50);
          setTimeout(() => editor.refresh(), 200);
        }
        if (isFitWidth && currentPdfDoc && !isRenderingPdf) {
          setTimeout(() => renderAllPdfPages(), 150);
        }
      }
    } else if (isWide && lastIsNarrow) {
      // Transitioned from Narrow to Wide (e.g. un-snapped or maximized)
      lastIsNarrow = false;
      if (autoCollapsedBySnap && document.body.classList.contains('drawer-collapsed')) {
        document.body.classList.remove('drawer-collapsed');
        autoCollapsedBySnap = false;
        applySplitRatio();
        if (editor && editor.refresh) {
          setTimeout(() => editor.refresh(), 50);
          setTimeout(() => editor.refresh(), 200);
        }
        if (isFitWidth && currentPdfDoc && !isRenderingPdf) {
          setTimeout(() => renderAllPdfPages(), 150);
        }
      }
    }
  }

  // Drawer Toggle button: manual click always toggles and overrides auto-snap state
  const btnToggleDrawer = document.getElementById('btn-toggle-drawer');
  if (btnToggleDrawer) {
    btnToggleDrawer.addEventListener('click', () => {
      document.body.classList.toggle('drawer-collapsed');
      // When user manually clicks, clear autoCollapsedBySnap so their manual intent is preserved
      autoCollapsedBySnap = false;
      applySplitRatio();
      if (editor && editor.refresh) {
        setTimeout(() => editor.refresh(), 50);
        setTimeout(() => editor.refresh(), 200);
      }
      if (isFitWidth && currentPdfDoc && !isRenderingPdf) {
        setTimeout(() => renderAllPdfPages(), 150);
      }
    });
  }

  // Window Resize: keep proportions intact, detect snap boundary & refresh layout
  window.addEventListener('resize', () => {
    applySplitRatio();
    if (editor && editor.refresh) editor.refresh();
    checkResponsiveDrawerSnap(false);

    if (isFitWidth && currentPdfDoc && !isRenderingPdf) {
      if (pdfResizeDebounceTimer) clearTimeout(pdfResizeDebounceTimer);
      pdfResizeDebounceTimer = setTimeout(() => {
        renderAllPdfPages();
      }, 250);
    }
  });

  // Initial snap state detection
  checkResponsiveDrawerSnap(true);

  // Compile button
  document.getElementById('btn-compile').addEventListener('click', () => triggerCompile(true));
  document.getElementById('btn-initial-compile').addEventListener('click', () => triggerCompile(true));

  // Auto Compile Toggle
  toggleAutoCompile.addEventListener('change', (e) => {
    autoCompileEnabled = e.target.checked;
    setCompileStatus('idle', autoCompileEnabled ? '自动编译已开启' : '自动编译已暂停');
  });

  // View modes
  document.getElementById('btn-view-code').addEventListener('click', () => setViewMode('code'));
  document.getElementById('btn-view-split').addEventListener('click', () => setViewMode('split'));
  document.getElementById('btn-view-paper').addEventListener('click', () => setViewMode('paper'));

  // Refresh PDF
  document.getElementById('btn-refresh-pdf').addEventListener('click', () => {
    if (currentProjectId) {
      showPdf(`/api/projects/${currentProjectId}/pdf?t=${Date.now()}`);
    }
  });

  // Error toggle & close handlers
  const errorToggle = document.getElementById('error-panel-toggle');
  const errorClose = document.getElementById('btn-error-close');
  const errorToggleIcon = document.getElementById('error-toggle-icon');

  if (errorToggle) {
    errorToggle.addEventListener('click', (e) => {
      if (e.target.closest('#btn-error-close')) return;
      errorPanel.classList.toggle('collapsed');
      const isCollapsed = errorPanel.classList.contains('collapsed');
      if (errorToggleIcon) {
        errorToggleIcon.textContent = isCollapsed ? '▲' : '▼';
      }
    });
  }

  if (errorClose) {
    errorClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideErrors();
    });
  }

  // Global shortcuts (Ctrl+F, Ctrl+H, Ctrl+J, Ctrl+B, Ctrl+I, Ctrl+U, Escape)
  window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key ? e.key.toLowerCase() : '';

    if (isCtrl && key === 'f' && !isShift) {
      e.preventDefault();
      openSearchBar(false);
    } else if (isCtrl && key === 'h' && !isShift) {
      e.preventDefault();
      openSearchBar(true);
    } else if (isCtrl && key === 'j' && !isShift) {
      e.preventDefault();
      triggerSyncTeXForward();
    } else if (isCtrl && key === 'b' && !isShift) {
      e.preventDefault();
      if (editor) formatBold(editor);
    } else if (isCtrl && key === 'i' && !isShift) {
      e.preventDefault();
      if (editor) formatItalic(editor);
    } else if (isCtrl && key === 'u' && !isShift) {
      e.preventDefault();
      if (editor) formatUnderline(editor);
    } else if (isCtrl && isShift && key === 'c') {
      e.preventDefault();
      if (editor) formatCode(editor);
    } else if (isCtrl && isShift && key === 'm') {
      e.preventDefault();
      if (editor) formatInlineMath(editor);
    } else if (isCtrl && isShift && key === 'e') {
      e.preventDefault();
      if (editor) formatEquation(editor);
    } else if (e.key === 'Escape') {
      closeSearchBar();
      hideMathTooltip();
    }
  });

  // Initialize media preview interactions (pan/zoom) and tab bar
  initMediaPreviewInteractions();

  // Load projects & system info
  loadProjects();
  refreshSystemStorageInfo();
});
