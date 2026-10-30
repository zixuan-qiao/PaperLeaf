<p align="center">
  <img src="static/icon-192.png" alt="PaperLeaf Logo" width="108" height="108" />
</p>

<h1 align="center">PaperLeaf 🌿</h1>

<p align="center">
  <strong>Overleaf 的免费本地离线替代方案 · 左侧代码右侧实时编译 · 开箱即用</strong><br>
  <em>A free, offline, local alternative to Overleaf with instant preview and zero configuration.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows" alt="Platform" />
  <img src="https://img.shields.io/badge/engine-Tectonic-brightgreen.svg" alt="Engine" />
  <img src="https://img.shields.io/badge/editor-CodeMirror-orange.svg" alt="Editor" />
  <img src="https://img.shields.io/badge/viewer-PDF.js-red.svg" alt="Viewer" />
</p>

---

## 🌟 为什么选择 PaperLeaf？(Why PaperLeaf?)

传统的 LaTeX 本地环境配置繁琐、动辄占用系统 **C 盘 7~8 GB** 空间；而云端 Overleaf 免费版编译时间受限、网络时有波动，高级版订阅昂贵。

**PaperLeaf** 为学术科研人员量身打造：
- 🚀 **真正开箱即用（免配 TeX Live）**：基于现代单文件轻量引擎 **Tectonic**，仅在首次使用宏包时自动按需下载并缓存，告别数小时的冗长安装。
- 🛡️ **0 污染 C 盘空间**：程序代码、编译核心、宏包缓存与项目文件**全部锁定在便携目录下**，坚决不占 C 盘一分一毫。
- ⚡ **左侧代码，右侧毫秒级编译**：输入停止即触发自动防抖编译，也可以通过 `Ctrl + S` 瞬间触发，享受如丝般顺滑的编写体验。
- 🎯 **1:1 对齐 Overleaf 双向跳转（SyncTeX）**：
  - **正向跳转**：双击左侧源码（或点击中缝 `➔` 箭头 / `Ctrl + J`），右侧 PDF 平滑滚动并将目标行居中，呈现呼吸微光脉冲高亮圈。
  - **逆向跳转**：双击右侧 PDF 段落或公式（或选中文字点击 `⬅` 箭头），左侧代码精准定位至所在文件与行号，并闪烁高亮。
- 📐 **数学公式光标实时预览（KaTeX）**：当光标移至 `$ ... $` 或 `equation` 环境内，上方自动浮现印刷级矢量公式卡片与智能输入语法提示。
- 📁 **现代学术 IDE 工作流**：
  - **多标签页（Multi-Tabs）**：支持打开多个 `.tex`、`.bib`、`.cls` 及插图文件，支持滚轮横向切换与快捷关闭。
  - **多级文件树管理**：支持自由新建子文件夹（如 `figures/`），一键插入相对路径图片代码。
  - **智能半屏贴边自适应（Responsive Snap）**：当窗口分屏贴边到屏幕一侧时，项目抽屉自动折叠，把空间完全留给双栏写作；拉大时自动恢复。
  - **矢量插图平移漫游与无级缩放**：图片和矢量 PDF 均支持小手抓取拖拽（`cursor: grab`）与 `Ctrl + 滚轮` 平滑无级缩放。
  - **深色/浅色模式无缝切换**。

---

## 🖥️ 快速开始 (Quick Start)

### 运行环境要求
- **操作系统**：Windows 10 / Windows 11
- **Python 环境**：Python 3.8+（建议 Anaconda 或官方 Python）
- **Web 视图**：系统自带的 Microsoft Edge

### 一键安装与使用 (Zero-Config Setup)
1. **克隆或下载本仓库**到本地任意目录（例如 `D:\PaperLeaf` 或 `E:\PaperLeaf`）：
   ```bash
   git clone https://github.com/YOUR_USERNAME/PaperLeaf.git
   ```
2. **首次一键初始化**：
   - 双击运行根目录下的 **`install.bat`**（或 `setup.bat`）；
   - 脚本将全自动识别 Python 环境、安装必要依赖、准备离线 Tectonic 编译核心，并**自动在您的桌面上生成专属的 PaperLeaf 绿色快捷方式**！
3. **日常使用**：
   - 随时双击桌面的 **【PaperLeaf】** 快捷方式图标即可直接秒开；
   - 也可以随时双击目录内的 **`run.bat`** 或 **`launch.vbs`** 启动。

---

## 🛠️ 技术架构 (Architecture)

- **Backend**：Python / Flask（轻量本地调度服务，管理项目 IO 与 SyncTeX 坐标解析）
- **Engine**：[Tectonic](https://tectonic-typesetting.github.io/)（单文件跨平台 XeTeX 编译引擎）
- **Editor**：[CodeMirror](https://codemirror.net/)（内嵌 LaTeX 语法高亮、自动括号补全、快捷键绑定）
- **PDF Viewer**：[PDF.js](https://mozilla.github.io/pdf.js/)（HTML5 Canvas + TextLayer 高精度多页渲染与文本划选）
- **Formula Preview**：[KaTeX](https://katex.org/)（毫秒级离线数学公式解析引擎）

---

## 📜 开源协议 (License)

本项目采用 [MIT 许可证](LICENSE) 开源。您可以免费用于学术科研与个人创作。

---

## ⚠️ 免责声明 (Disclaimer)

*PaperLeaf 是一个独立的开源项目，灵感来源于学术界优秀的在线协作工具 Overleaf。本项目与 Overleaf Ltd. 或 Digital Science 之间无任何商业隶属、官方合作或背书关系。*
