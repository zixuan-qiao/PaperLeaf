(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"), require("./foldcode"), require("./brace-fold"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror", "./foldcode", "./brace-fold"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  var SECTION_LEVELS = {
    "part": 0,
    "chapter": 1,
    "section": 2,
    "subsection": 3,
    "subsubsection": 4,
    "paragraph": 5,
    "subparagraph": 6
  };

  function latexFold(cm, start) {
    var line = start.line;
    var lineText = cm.getLine(line);
    if (!lineText) return null;

    // 1. Check for LaTeX Environments: \begin{env} ... \end{env}
    var beginRegex = /\\begin\{([a-zA-Z0-9*_-]+)\}/g;
    var beginMatch;
    var targetMatch = null;

    while ((beginMatch = beginRegex.exec(lineText)) !== null) {
      if (start.ch === null || start.ch === undefined || beginMatch.index >= start.ch || (beginMatch.index + beginMatch[0].length) >= start.ch) {
        targetMatch = beginMatch;
        break;
      }
    }
    if (!targetMatch) {
      beginRegex.lastIndex = 0;
      targetMatch = beginRegex.exec(lineText);
    }

    if (targetMatch) {
      var envName = targetMatch[1];
      var depth = 1;
      var lastLine = cm.lastLine();
      var endRegex = new RegExp("\\\\end\\{" + envName.replace("*", "\\*") + "\\}", "g");
      var nestedBeginRegex = new RegExp("\\\\begin\\{" + envName.replace("*", "\\*") + "\\}", "g");

      var restOfCurrentLine = lineText.slice(targetMatch.index + targetMatch[0].length);
      var subMatch;
      while ((subMatch = endRegex.exec(restOfCurrentLine)) !== null) {
        depth--;
        if (depth === 0) return null;
      }

      for (var l = line + 1; l <= lastLine; ++l) {
        var curText = cm.getLine(l);
        if (!curText) continue;

        var commentIdx = curText.indexOf("%");
        var activeText = (commentIdx >= 0) ? curText.slice(0, commentIdx) : curText;

        nestedBeginRegex.lastIndex = 0;
        while (nestedBeginRegex.exec(activeText) !== null) {
          depth++;
        }

        endRegex.lastIndex = 0;
        var endMatch;
        while ((endMatch = endRegex.exec(activeText)) !== null) {
          depth--;
          if (depth === 0) {
            var endCol = endMatch.index;
            return {
              from: CodeMirror.Pos(line, lineText.length),
              to: CodeMirror.Pos(l, endCol)
            };
          }
        }
      }
      return null;
    }

    // 2. Check for LaTeX Section Commands: \section, \subsection, etc.
    var secMatch = lineText.match(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/);
    if (secMatch) {
      var secType = secMatch[1];
      var secLevel = SECTION_LEVELS[secType];
      if (secLevel !== undefined) {
        var lastLineNo = cm.lastLine();
        var foldEndLine = lastLineNo;
        var anySecRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/;

        for (var i = line + 1; i <= lastLineNo; ++i) {
          var t = cm.getLine(i);
          var m = t.match(anySecRegex);
          if (m) {
            var otherLevel = SECTION_LEVELS[m[1]];
            if (otherLevel !== undefined && otherLevel <= secLevel) {
              foldEndLine = i - 1;
              break;
            }
          }
          if (t.indexOf("\\end{document}") !== -1) {
            foldEndLine = i - 1;
            break;
          }
        }

        if (foldEndLine > line) {
          return {
            from: CodeMirror.Pos(line, lineText.length),
            to: CodeMirror.Pos(foldEndLine, cm.getLine(foldEndLine).length)
          };
        }
        return null;
      }
    }

    // 3. Check for Custom Region Folding (% region / % endregion or %{ / %})
    if (/%\s*(?:region|\{)/i.test(lineText)) {
      var depthReg = 1;
      var lastL = cm.lastLine();
      for (var rl = line + 1; rl <= lastL; ++rl) {
        var rText = cm.getLine(rl);
        if (/%\s*(?:region|\{)/i.test(rText)) depthReg++;
        if (/%\s*(?:endregion|\})/i.test(rText)) {
          depthReg--;
          if (depthReg === 0) {
            return {
              from: CodeMirror.Pos(line, lineText.length),
              to: CodeMirror.Pos(rl, rText.length)
            };
          }
        }
      }
      return null;
    }

    // 4. Fallback to standard brace-fold for multi-line { ... }
    if (CodeMirror.fold && CodeMirror.fold.brace) {
      return CodeMirror.fold.brace(cm, start);
    }

    return null;
  }

  CodeMirror.registerHelper("fold", "latex", latexFold);
  CodeMirror.registerHelper("fold", "stex", latexFold);
});
