/**
 * injected.js — 运行在页面 MAIN world
 *
 * 职责：
 *  - 复用 Kibana 页面内置的 Ace Editor（window.ace）
 *  - 监听结果区(.conApp__output)的点击，上报文档全文/偏移/屏幕坐标给 content.js
 *  - 接收 content.js 的 REPLACE 指令，对结果区做局部文本替换
 *
 * 与 content.js 通过 window.postMessage 通信（同源 + 自定义标识双向校验）。
 */
(function () {
  'use strict';

  var OUTPUT_SELECTOR = '.conApp__output'; // 实测 Kibana 7.5.1 结果区 Ace 容器
  var MSG_FROM_INJECTED = 'KFE_INJECTED';
  var MSG_FROM_CONTENT = 'KFE_CONTENT';

  var boundEditor = null; // 已绑定监听的 editor，避免重复绑定

  function getResultEditor() {
    if (typeof window.ace === 'undefined' || !window.ace.edit) return null;
    var node = document.querySelector(OUTPUT_SELECTOR);
    if (!node) return null;
    try {
      // ace.edit(已存在容器) 返回已绑定实例，不会重建
      return window.ace.edit(node);
    } catch (e) {
      return null;
    }
  }

  function post(type, payload) {
    window.postMessage(
      { source: MSG_FROM_INJECTED, type: type, payload: payload },
      window.location.origin
    );
  }

  function bindEditor(editor) {
    if (!editor || editor === boundEditor) return;
    boundEditor = editor;

    editor.on('mousedown', function (e) {
      try {
        var pos = e.getDocumentPosition && e.getDocumentPosition(); // {row, column} 0-based
        if (!pos) return;
        var session = editor.getSession();
        var fullText = session.getValue();
        var offset = session.getDocument().positionToIndex(pos);
        var screen = editor.renderer.textToScreenCoordinates(pos.row, 0); // {pageX, pageY}
        post('CLICK', {
          fullText: fullText,
          offset: offset,
          pos: { row: pos.row, column: pos.column },
          screen: { pageX: screen.pageX, pageY: screen.pageY },
          lineHeight: editor.renderer.lineHeight || 16
        });
      } catch (err) {
        // 单次点击异常不应影响编辑器本身
        post('ERROR', { stage: 'mousedown', message: String(err) });
      }
    });

    // 结果区滚动时通知 content 隐藏浮层（changeScrollTop 是 Ace 虚拟滚动的标准事件）
    try {
      editor.getSession().on('changeScrollTop', function () { post('SCROLL', {}); });
    } catch (e) { /* ignore */ }
    // 兼容：部分版本滚动事件挂在 renderer/scrollbar 上
    try {
      if (editor.renderer && editor.renderer.scrollBarV && editor.renderer.scrollBarV.on) {
        editor.renderer.scrollBarV.on('scroll', function () { post('SCROLL', {}); });
      }
    } catch (e) { /* ignore */ }

    post('READY', {});
  }

  // 兼容多版本 Ace 获取 Range 构造器；都拿不到则返回 null（走回退方案）
  function getRangeCtor() {
    var ace = window.ace;
    try {
      if (ace && typeof ace.require === 'function') {
        var m = ace.require('ace/range');
        if (m && m.Range) return m.Range;
      }
    } catch (e) { /* ignore */ }
    try {
      if (ace && typeof ace.acequire === 'function') {
        var m2 = ace.acequire('ace/range');
        if (m2 && m2.Range) return m2.Range;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function buildRange(startPos, endPos) {
    var Range = getRangeCtor();
    if (Range) {
      return new Range(startPos.row, startPos.column, endPos.row, endPos.column);
    }
    // 回退：构造与 Ace Range 结构兼容的普通对象（session.replace 仅读取 start/end）
    return {
      start: { row: startPos.row, column: startPos.column },
      end: { row: endPos.row, column: endPos.column }
    };
  }

  function applyReplace(payload) {
    if (!boundEditor) return;
    var editor = boundEditor;
    var wasReadOnly = editor.getReadOnly();
    try {
      var session = editor.getSession();
      var doc = session.getDocument();
      var startPos = doc.indexToPosition(payload.startOffset);
      var endPos = doc.indexToPosition(payload.endOffset);

      editor.setReadOnly(false);

      var range = buildRange(startPos, endPos);
      try {
        session.replace(range, payload.newText);
      } catch (e1) {
        // 二次回退：删除原区间再插入（完全不依赖 Range 类）
        doc.remove(range);
        doc.insert(startPos, payload.newText);
      }

      editor.setReadOnly(wasReadOnly);
      post('REPLACED', { ok: true });
    } catch (err) {
      editor.setReadOnly(wasReadOnly);
      post('REPLACED', { ok: false, message: String(err) });
    }
  }

  // 接收 content.js 的指令（同源 + 自定义标识校验）
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.source !== MSG_FROM_CONTENT) return;

    if (d.type === 'REPLACE') {
      applyReplace(d.payload);
    } else if (d.type === 'PING') {
      // content.js 可能在结果区出现后请求重新绑定
      var ed = getResultEditor();
      if (ed) bindEditor(ed);
    }
  });

  // 轮询直到结果区 Ace 实例出现并完成绑定
  var tries = 0;
  (function initLoop() {
    var ed = getResultEditor();
    if (ed) {
      bindEditor(ed);
      return;
    }
    if (tries++ < 60) { // 最多约 30s（结果区在用户首次执行后才稳定存在）
      setTimeout(initLoop, 500);
    }
  })();
})();
