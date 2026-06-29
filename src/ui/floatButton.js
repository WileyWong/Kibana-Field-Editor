/**
 * floatButton.js — “修改值”半透明浮层（Shadow DOM 隔离）
 *
 * 暴露：
 *   window.__KFE.floatButton.show({ pageX, pageY, lineHeight, onClick })
 *   window.__KFE.floatButton.hide()
 */
(function () {
  'use strict';

  var host = null;     // 挂在页面上的宿主元素
  var shadow = null;
  var btn = null;
  var outsideHandler = null;
  var currentOnClick = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'kfe-float-host';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent =
      '.kfe-btn{position:fixed;display:inline-flex;align-items:center;' +
      'padding:2px 10px;font-size:12px;line-height:18px;color:#fff;' +
      'background:rgba(0,107,180,0.65);border-radius:4px;cursor:pointer;' +
      'user-select:none;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.2);' +
      'transition:background .15s;font-family:Segoe UI,Helvetica,Arial,sans-serif;}' +
      '.kfe-btn:hover{background:rgba(0,107,180,0.95);}';
    shadow.appendChild(style);

    btn = document.createElement('div');
    btn.className = 'kfe-btn';
    btn.textContent = '修改值';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var cb = currentOnClick;
      hide();
      if (cb) cb();
    });
    shadow.appendChild(btn);
  }

  function show(opts) {
    ensureHost();
    currentOnClick = opts.onClick || null;

    // 使用 fixed 定位：Ace 的 textToScreenCoordinates 返回的 pageX/pageY 是相对视口的坐标。
    // 垂直对齐到点击行；微调使按钮与行垂直居中。
    var lh = opts.lineHeight || 16;
    var top = (opts.pageY || 0) + Math.max(0, (lh - 22) / 2);
    btn.style.top = top + 'px';

    // 水平位置：贴近结果区右边缘
    btn.style.left = computeRightX() + 'px';

    host.style.display = 'block';
    btn.style.display = 'inline-flex';

    // 点击其他区域关闭
    if (!outsideHandler) {
      outsideHandler = function (ev) {
        // 点击发生在浮层自身则忽略（已由 btn 的 click 处理）
        var path = ev.composedPath ? ev.composedPath() : [];
        if (path.indexOf(btn) !== -1 || path.indexOf(host) !== -1) return;
        hide();
      };
      // 延迟绑定，避免触发本次显示的同一个 mousedown
      setTimeout(function () {
        document.addEventListener('mousedown', outsideHandler, true);
      }, 0);
    }
  }

  function computeRightX() {
    // 优先贴结果区右边缘（fixed 定位用视口坐标，不加 scrollX）
    var output = document.querySelector('.conApp__output');
    if (output) {
      var rect = output.getBoundingClientRect();
      return Math.max(0, rect.right - 72); // 留出按钮宽度
    }
    return window.innerWidth - 90;
  }

  function hide() {
    currentOnClick = null;
    if (btn) btn.style.display = 'none';
    if (host) host.style.display = 'none';
    if (outsideHandler) {
      document.removeEventListener('mousedown', outsideHandler, true);
      outsideHandler = null;
    }
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.floatButton = { show: show, hide: hide };
})();
