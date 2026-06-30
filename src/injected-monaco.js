/**
 * injected-monaco.js — 运行在页面 MAIN world（Kibana 8.16+ Monaco 版）
 *
 * 由于 Monaco 实例不可达（window.monaco 未暴露、DOM 未挂引用），本适配层不使用
 * Monaco JS API，而是：
 *   1. hook window.fetch，缓存最近一次 _search 的【完整响应 JSON】（绕开虚拟滚动取不到全文的问题）
 *   2. 监听结果区 [data-test-subj="consoleMonacoOutput"] 的 DOM click
 *   3. 用 Monaco 行号（绝对行号）+ 点击列，配合缓存的完整 JSON 上报给 content.js 定位
 *   4. Monaco 只读且虚拟渲染，不回写结果区（更新成功仅提示，需重新查询）
 *
 * 与 content.js 通过 window.postMessage 通信（同源 + 自定义标识双向校验）。
 */
(function () {
  'use strict';

  var OUTPUT_SELECTOR = '[data-test-subj="consoleMonacoOutput"]';
  var MSG_FROM_INJECTED = 'KFE_INJECTED';
  var MSG_FROM_CONTENT = 'KFE_CONTENT';

  var lastSearchJson = null; // 最近一次 _search 的完整响应文本
  var bound = false;

  function post(type, payload) {
    window.postMessage(
      { source: MSG_FROM_INJECTED, type: type, payload: payload },
      window.location.origin
    );
  }

  // ---------------- 1. hook fetch 缓存 _search 响应 ----------------
  function installFetchHook() {
    if (window.__kfeFetchHooked) return;
    window.__kfeFetchHooked = true;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = (input && input.url) || input || '';
      var p = origFetch.apply(this, arguments);
      try {
        if (/console\/proxy/.test(String(url)) && /_search/.test(decodeURIComponent(String(url)))) {
          p.then(function (resp) {
            try {
              resp.clone().text().then(function (txt) {
                if (txt && /"hits"/.test(txt)) {
                  lastSearchJson = txt;
                  post('SEARCH_CACHED', { length: txt.length });
                }
              });
            } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // ---------------- 2. 点击定位 ----------------
  // 取点击 view-line 对应的绝对行号（1-based）。
  // Monaco 每行等高，view-line 的 style.top 是相对内容顶部的绝对像素，
  // 行索引 = round(top / lineHeight)。这不依赖虚拟渲染的行号槽，最可靠。
  function getAbsoluteLineNumber(outNode, viewLine) {
    var topPx = parseFloat(viewLine.style.top);
    var hPx = parseFloat(viewLine.style.height) ||
              viewLine.getBoundingClientRect().height || 21;
    if (isNaN(topPx) || !hPx) return null;
    var idx = Math.round(topPx / hPx); // 0-based 行索引
    return idx + 1;                    // 1-based
  }

  // Monaco 在文本上层盖了 .view-lines.monaco-mouse-cursor-text 覆盖层，点击 target 往往是它，
  // 不是具体 .view-line。改用点击坐标的 Y，匹配 Y 落在其矩形范围内的那一行。
  function findViewLineByPoint(outNode, clientX, clientY) {
    // 优先用 elementsFromPoint（拿到该点所有层叠元素，含被覆盖的 view-line）
    var stack = document.elementsFromPoint ? document.elementsFromPoint(clientX, clientY) : [];
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el.classList && el.classList.contains('view-line')) return el;
      if (el.closest) {
        var vl = el.closest('.view-line');
        if (vl) return vl;
      }
    }
    // 回退：遍历所有 view-line，找 Y 落在其 rect 内的
    var lines = outNode.querySelectorAll('.view-line');
    for (var j = 0; j < lines.length; j++) {
      var r = lines[j].getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return lines[j];
    }
    return null;
  }

  // 估算点击落在该行文本的列（0-based 字符数）
  function getClickColumn(viewLine, clientX) {
    var col = 0;
    var spans = viewLine.querySelectorAll('span');
    // Monaco 的 view-line 下是一层层 span，逐个累加并用边界判断
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      // 只统计叶子 span（无子 span 的）
      if (sp.children && sp.children.length > 0) continue;
      var rect = sp.getBoundingClientRect();
      var len = (sp.textContent || '').length;
      if (clientX < rect.left) {
        return col;
      }
      if (clientX <= rect.right) {
        var ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        return col + Math.max(0, Math.min(len, Math.round(ratio * len)));
      }
      col += len;
    }
    return col;
  }

  function onClick(e) {
    try {
      var outNode = document.querySelector(OUTPUT_SELECTOR);
      if (!outNode) return;
      // 事件委托：仅处理落在结果区内的点击（结果区 DOM 会随每次查询重建，故不绑具体节点）
      if (!outNode.contains(e.target)) return;
      var viewLine = findViewLineByPoint(outNode, e.clientX, e.clientY);
      if (!viewLine) return;
      if (!lastSearchJson) {
        post('NO_CACHE', {});
        return;
      }
      var lineNo = getAbsoluteLineNumber(outNode, viewLine); // 1-based（辅助，不再作为主定位依据）
      var col = getClickColumn(viewLine, e.clientX);
      // 行号在缓存JSON与显示JSON不一致时不可靠，改用行文本trim后在缓存JSON中精确匹配
      var lineText = (viewLine.textContent || '').replace(/^\s+/, '');

      // 浮层定位：用点击行(view-line)自身的屏幕矩形，贴其右侧、垂直对齐该行
      var rect = viewLine.getBoundingClientRect();
      post('CLICK_MONACO', {
        fullText: lastSearchJson,
        line: lineNo,        // 1-based（仅作辅助，定位以 lineText 为准）
        lineText: lineText,  // 点击行 trim 后的文本，用于在 fullText 中精确匹配定位
        column: col,         // 0-based 列
        screen: { pageX: rect.right, pageY: rect.top },
        lineHeight: rect.height || 21
      });
    } catch (err) {
      post('ERROR', { stage: 'monaco-click', message: String(err) });
    }
  }

  function bindOutput() {
    if (bound) return;
    // 事件委托绑到 document（捕获阶段）：结果区每次查询会重建 DOM，绑具体节点会失效。
    bound = true;
    document.addEventListener('click', onClick, true);
    // 滚动：用捕获阶段在 document 上监听，落在结果区内的滚动才通知隐藏浮层
    document.addEventListener('scroll', function (e) {
      var outNode = document.querySelector(OUTPUT_SELECTOR);
      if (outNode && e.target && (outNode === e.target || outNode.contains(e.target))) {
        post('SCROLL', {});
      }
    }, true);
    post('READY', { editor: 'monaco' });
  }

  // ---------------- 启动 ----------------
  installFetchHook();
  var tries = 0;
  (function initLoop() {
    bindOutput();
    if (!bound && tries++ < 120) setTimeout(initLoop, 500);
  })();

  // 接收 content.js 指令（Monaco 版不回写，仅处理 PING 重绑）
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.source !== MSG_FROM_CONTENT) return;
    if (d.type === 'PING') bindOutput();
  });
})();
