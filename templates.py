import os

TEMPLATES = {
    "chinese": {
        "name": "中文学术论文 (CTeX)",
        "description": "基于 ctexart 的标准中文学术模板，原生支持中文与数学排版",
        "content": r"""\documentclass[UTF8, fontset=windows]{ctexart}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{geometry}
\geometry{a4paper, margin=1in}

\title{基于本地免配置环境的中文学术论文}
\author{作者姓名}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
本文展示了一个完全免配置、本地运行、支持中文排版与实时编译的 LaTeX 工作流。无需手动安装数 GB 的 TeX Live，宏包按需自动下载并持久化在本地缓存中。
\end{abstract}

\section{引言}
欢迎使用 PaperLeaf！Tectonic 基于现代 XeTeX 架构，原生支持 Unicode 字符集以及系统自带中文字体。

\section{数学公式展示}
爱因斯坦质能等价理论：
\begin{equation}
E = mc^2
\end{equation}

高斯积分计算：
\begin{equation}
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
\end{equation}

欧拉恒等式：
\begin{equation}
e^{i\pi} + 1 = 0
\end{equation}

\section{列表与排版}
\begin{itemize}
    \item 零配置：无需手动设置复杂的环境变量。
    \item 零 C 盘污染：宏包和项目缓存全部收敛在软件本地目录。
    \item 实时预览：支持代码与 PDF 对照编辑。
\end{itemize}

\section{结论}
中文排版流畅，字体自然，满足日常学术论文与报告撰写需求。

\end{document}
"""
    },
    "english": {
        "name": "English Research Paper (Standard)",
        "description": "Standard article template suitable for international conferences and journals",
        "content": r"""\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{graphicx}
\usepackage{geometry}
\geometry{a4paper, margin=1in}

\title{A Minimalist, Zero-Config LaTeX Workflow}
\author{Researcher Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
This document demonstrates a lightweight, zero-configuration local LaTeX environment powered by modern typeset engines. No heavy TeX distributions are required.
\end{abstract}

\section{Introduction}
Welcome to PaperLeaf! Writing math equations and technical documents locally is fast, clean, and completely offline-capable after initial package caching.

\section{Mathematical Formulations}
Einstein's Mass-Energy Equivalence:
\begin{equation}
E = mc^2
\end{equation}

The Famous Gaussian Integral:
\begin{equation}
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
\end{equation}

Euler's Identity:
\begin{equation}
e^{i\pi} + 1 = 0
\end{equation}

\section{Features}
\begin{itemize}
    \item Real-time split view with draggable dividers.
    \item Zen mode for uninterrupted writing.
    \item On-demand package caching in local data directory.
\end{itemize}

\section{Conclusion}
The compilation is fast, lightweight, and completely free.

\end{document}
"""
    }
}
