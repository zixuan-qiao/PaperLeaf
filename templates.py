import os

TEMPLATES = {
    "chinese": {
        "id": "chinese",
        "name": "中文学术论文 (CTeX)",
        "category": "中文学术",
        "icon": "🇨🇳",
        "badge": "CTeX",
        "language": "chinese",
        "description": "基于 ctexart 的标准中文学术排版模板，原生支持中文与数学排版，开箱即用。",
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
        "id": "english",
        "name": "英文学术论文 (Standard)",
        "category": "国际通用",
        "icon": "🇬🇧",
        "badge": "Article",
        "language": "english",
        "description": "标准英文单栏学术手稿模板，适合国际期刊、常规学术会议的论文初稿与草案。",
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
    \item Two-way SyncTeX navigation between editor and PDF.
    \item Pure local storage with zero C-drive pollution.
\end{itemize}

\section{Conclusion}
The compilation is fast, lightweight, and completely free.

\end{document}
"""
    },
    "ieee": {
        "id": "ieee",
        "name": "IEEE 会议论文 (IEEEtran)",
        "category": "国际顶会",
        "icon": "⚡",
        "badge": "IEEE",
        "language": "english",
        "description": "电子电气与计算机领域顶级会议标配双栏模板，内置作者信息栏、公式与关键词规范。",
        "content": r"""\documentclass[conference]{IEEEtran}
\usepackage{cite}
\usepackage{amsmath,amssymb,amsfonts}
\usepackage{algorithmic}
\usepackage{graphicx}
\usepackage{textcomp}
\usepackage{xcolor}

\begin{document}

\title{PaperLeaf: A Zero-Config, Portable LaTeX Typesetting System for Academic Writing}

\author{\IEEEauthorblockN{First Author}
\IEEEauthorblockA{\textit{Department of Computer Science} \\
\textit{University Name}\\
City, Country \\
author1@example.com}
\and
\IEEEauthorblockN{Second Author}
\IEEEauthorblockA{\textit{School of Artificial Intelligence} \\
\textit{Research Institute}\\
City, Country \\
author2@example.com}
}

\maketitle

\begin{abstract}
This document demonstrates the standard IEEE conference double-column format in PaperLeaf. It provides sub-second compilation, bidirectional SyncTeX jump, and offline package caching.
\end{abstract}

\begin{IEEEkeywords}
LaTeX, Typesetting, Tectonic, Real-time Preview, Academic Writing
\end{IEEEkeywords}

\section{Introduction}
Writing IEEE format papers locally has never been easier. With PaperLeaf, all packages and fonts are resolved on demand without requiring a full 8GB TeX Live distribution.

\section{System Architecture}
\subsection{Mathematical Formulations}
The loss function for multi-task optimization is formulated as:
\begin{equation}
\mathcal{L}_{\text{total}} = \alpha \mathcal{L}_{\text{task}} + \beta \mathcal{L}_{\text{reg}} + \gamma \|\mathbf{W}\|_2^2
\label{eq:loss}
\end{equation}
where $\alpha, \beta, \gamma$ denote trade-off hyperparameters.

\subsection{Algorithmic Pipeline}
Our execution pipeline satisfies three core principles:
\begin{enumerate}
    \item \textbf{Zero C-Drive Footprint}: All cache and binaries remain portable.
    \item \textbf{Sub-second Rendering}: High-speed continuous compilation.
    \item \textbf{Two-Way SyncTeX}: Seamless synchronization between editor and PDF.
\end{enumerate}

\section{Conclusion}
This template is ready for submission to international IEEE conferences and workshops.

\end{document}
"""
    },
    "acm": {
        "id": "acm",
        "name": "ACM 国际学术会议 (acmart)",
        "category": "国际顶会",
        "icon": "🏛️",
        "badge": "ACM",
        "language": "english",
        "description": "ACM SIGCONF 官方双栏学术会议标准模板，适合 SIGMOD、KDD、CHI、CCS 等顶会。",
        "content": r"""\documentclass[sigconf]{acmart}

\settopmatter{printacmref=false}
\renewcommand\footnotetextcopyrightpermission[1]{}
\pagestyle{plain}

\title{PaperLeaf: Next-Generation Local Academic Typesetting Environment}

\author{First Author}
\affiliation{
  \institution{University Name}
  \city{City}
  \country{Country}
}
\email{first.author@example.edu}

\author{Second Author}
\affiliation{
  \institution{Research Laboratory}
  \city{City}
  \country{Country}
}
\email{second.author@example.edu}

\begin{document}

\begin{abstract}
We introduce PaperLeaf, an open-source, lightweight, local-first alternative to Overleaf. By leveraging modern typeset engines and HTML5 canvas viewers, PaperLeaf achieves sub-second responsive preview with bidirectional SyncTeX synchronization.
\end{abstract}

\keywords{Local-first software, LaTeX, SyncTeX, Academic writing}

\maketitle

\section{Introduction}
The ACM SIGCONF layout is the standard format for major computer science conferences. PaperLeaf supports automatic dependency resolving and instant local compilation.

\section{Core Methodology}
\subsection{Problem Statement}
Let $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^N$ be the input dataset. The objective is to minimize empirical risk:
\begin{equation}
\min_{\theta} \frac{1}{N} \sum_{i=1}^N \ell(f(x_i; \theta), y_i)
\end{equation}

\subsection{System Design}
PaperLeaf operates as a self-contained local workspace:
\begin{itemize}
    \item No Docker or heavy runtime required.
    \item Instant two-way synchronization via SyncTeX.
    \item Local snapshots with visual diff comparison.
\end{itemize}

\section{Conclusion}
This template provides a ready-to-use starting point for ACM conference papers.

\end{document}
"""
    },
    "beamer": {
        "id": "beamer",
        "name": "学术汇报幻灯片 (Beamer 16:9)",
        "category": "汇报演示",
        "icon": "📊",
        "badge": "Beamer",
        "language": "english",
        "description": "16:9 现代宽屏学术答辩/组会汇报 PPT 模板，预置精致主题配色与定理公式卡片。",
        "content": r"""\documentclass[aspectratio=169]{beamer}
\usetheme{Madrid}
\usecolortheme{whale}

\title[Academic Research Presentation]{PaperLeaf: Modern Academic Presentation}
\subtitle{Zero-Config Portable Typesetting for Research Teams}
\author{Speaker Name}
\institute{School of Computer Science, University}
\date{\today}

\begin{document}

\frame{\titlepage}

\begin{frame}{Outline}
\tableofcontents
\end{frame}

\section{Research Background}
\begin{frame}{Background \& Motivation}
\begin{itemize}
    \item \textbf{Heavy TeX Live}: Takes 7--8 GB on system drive C.
    \item \textbf{Online Cloud Latency}: Overleaf free tier has compile queue limits.
    \item \textbf{The Solution}: PaperLeaf provides instant local compilation with zero setup!
\end{itemize}
\end{frame}

\section{System Architecture}
\begin{frame}{Mathematical Formulation}
\begin{block}{Theoretical Formulation}
The multi-modal objective function is defined as:
\[
\mathcal{L}_{\text{total}} = \mathcal{L}_{\text{task}} + \lambda \mathcal{L}_{\text{reg}} + \gamma \mathcal{R}(\Theta)
\]
\end{block}

\begin{alertblock}{Key Advantage}
Sub-second compilation cycle with full bidirectional SyncTeX navigation!
\end{alertblock}
\end{frame}

\section{Conclusion}
\begin{frame}{Summary \& Future Work}
\begin{enumerate}
    \item Portable, lightweight, and zero configuration.
    \item Rich visual diff comparison and history tracking.
    \item Ready for academic conferences and dissertation defense!
\end{enumerate}
\vspace{1em}
\centering
\textbf{Thank You for Your Attention!}
\end{frame}

\end{document}
"""
    },
    "thesis": {
        "id": "thesis",
        "name": "毕业设计与学位论文大纲 (Thesis)",
        "category": "学位论文",
        "icon": "🎓",
        "badge": "Thesis",
        "language": "chinese",
        "description": "本硕博毕业设计标准大纲结构，包含封面、中英文摘要、目录、正文章节与致谢。",
        "content": r"""\documentclass[UTF8, fontset=windows, 12pt]{ctexart}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{geometry}
\usepackage{hyperref}
\usepackage{booktabs}
\usepackage{cite}
\geometry{a4paper, left=3cm, right=2.5cm, top=2.5cm, bottom=2.5cm}

\title{\heiti\zihao{2} 基于深度学习与轻量化架构的毕业设计论文题目}
\author{\kaishu 作者姓名 \quad 指导教师：导师姓名}
\date{\today}

\begin{document}
\maketitle
\thispagestyle{empty}
\newpage

\pagenumbering{Roman}
\begin{abstract}
这是学位论文中文摘要部分。本文提出了一种全新的方法，通过严谨的对比实验证明了该方案的优越性与有效性。
\par\textbf{关键词：} 毕业设计；深度学习；轻量化架构；LaTeX 排版
\end{abstract}
\newpage

\renewcommand{\abstractname}{Abstract}
\begin{abstract}
This is the English abstract section of the graduation thesis. We propose a novel framework and conduct comprehensive empirical experiments.
\par\textbf{Keywords:} Graduation Thesis, Deep Learning, Lightweight Architecture, LaTeX Typesetting
\end{abstract}
\newpage

\tableofcontents
\newpage

\pagenumbering{arabic}
\section{绪论}
\subsection{课题研究背景与意义}
毕业设计论文绪论介绍研究背景、现状及本课题的核心贡献。

\subsection{国内外研究现状}
国内外学者的相关研究成果综述。

\section{理论基础与核心方法}
\subsection{系统总体设计}
系统采用模块化分层设计。

\subsection{算法理论公式}
核心优化目标函数如下：
\begin{equation}
\min_{\theta} \mathcal{L}(\theta) = \frac{1}{N} \sum_{i=1}^N \ell(f(x_i; \theta), y_i) + \lambda \|\theta\|_2^2
\end{equation}

\section{实验评估与结果分析}
\subsection{实验环境与数据集}
说明实验配置硬件及数据集详情。

\subsection{实验指标对比}
\begin{table}[htbp]
\centering
\caption{不同方案性能指标对比}
\begin{tabular}{lccc}
\toprule
方法 & 准确率 (\%) & 参数量 (M) & 耗时 (ms) \\
\midrule
Baseline 方案 & 85.2 & 24.5 & 45 \\
改进方案 A & 89.6 & 18.2 & 32 \\
\textbf{本文提出方案} & \textbf{94.8} & \textbf{7.6} & \textbf{12} \\
\bottomrule
\end{tabular}
\end{table}

\section{结论与展望}
总结全文工作，提出未来改进方向。

\section*{致谢}
感谢导师的悉心指导，感谢实验室同门的帮助与支持。

\end{document}
"""
    }
}
