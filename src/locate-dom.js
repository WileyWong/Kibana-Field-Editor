/**
 * locate-dom.js — Monaco 版定位适配（运行在 content.js 的 isolated world）
 *
 * Monaco 版无法拿到编辑器实例的 offset API，且缓存 JSON 与 Monaco 显示的行结构
 * 在长文本换行时可能不一致，因此**不能用行号**定位。改用行文本精确匹配。
 *
 * 流程：点击行 trim 文本 → 在缓存完整 JSON 中 indexOf 精确匹配 → 得到 offset → 复用 locate.js
 *
 * 暴露：window.__KFE.locateByLineCol(fullText, line, column, lineText)
 *       line/column 仅作"大致区域"辅助（消歧重复行），主定位以 lineText 文本匹配为准
 */
(function () {
  'use strict';

  // 1-based 行号 + 0-based 列 → 0-based 字符 offset（辅助用，不精确）
  function roughOffset(fullText, line) {
    var i = 0, curLine = 1;
    while (i < fullText.length && curLine < line) {
      if (fullText.charCodeAt(i) === 10) curLine++;
      i++;
    }
    return i;
  }

  /**
   * 用 lineText 在 fullText 中精确匹配，得到 offset。
   * line 参数用于缩小搜索范围（从大致区域开始搜）。
   * 若精确匹配失败，回退到行号+列的传统方式。
   */
  function locateByLineCol(fullText, line, column, lineText) {
    if (!window.__KFE || !window.__KFE.locate) return null;
    if (!fullText) return null;

    var result = null;

    if (lineText && lineText.length > 0) {
      var keyMatch = /^"([^"]+)"\s*:/.exec(lineText);
      var searchStr = keyMatch ? ('"' + keyMatch[1] + '"') : lineText;

      // 全文搜索匹配
      var idx = fullText.indexOf(searchStr);
      if (idx >= 0) {
        // 直接用匹配位置调 locate（AST 定位会自动找到该节点的正确字段，无需加列偏移）
        result = window.__KFE.locate(fullText, idx);
        if (result) return result;

        // 兜底：在匹配行附近扫描
        var scanStart = fullText.lastIndexOf('\n', idx - 1);
        if (scanStart < 0) scanStart = 0;
        var scanEnd = fullText.indexOf('\n', idx);
        if (scanEnd < 0) scanEnd = fullText.length;
        for (var p = scanStart; p < scanEnd; p++) {
          var r = window.__KFE.locate(fullText, p);
          if (r) return r;
        }
      }
    }

    // 回退：行号+列
    if (line) {
      var fallbackOffset = roughOffset(fullText, line) + (column || 0);
      result = window.__KFE.locate(fullText, fallbackOffset);
      if (result) return result;
    }

    return null;
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.locateByLineCol = locateByLineCol;
})();
