/**
 * content.js — 主编排（ISOLATED world）
 *
 * 流程：
 *   hash 校验 → 版本兼容检测（编辑器类型探测）→ 注入 injected.js → 绑定消息
 *   点击 CLICK → locate 定位字段 → 显示浮层 → 点浮层弹窗 → 确认 → updateField
 *   成功：展示结果 + 通知 injected REPLACE 替换 Ace 文本；失败：仅展示错误
 */
(function () {
  'use strict';

  var KFE = window.__KFE || (window.__KFE = {});
  var MSG_FROM_INJECTED = 'KFE_INJECTED';
  var MSG_FROM_CONTENT = 'KFE_CONTENT';

  var initialized = false;     // 防止重复初始化
  var injectedReady = false;
  var lastCtx = null;          // 当前命中的字段上下文（用于提交）
  var esVersion = null;

  // -------- 工具：发送指令给 injected --------
  function postToInjected(type, payload) {
    window.postMessage(
      { source: MSG_FROM_CONTENT, type: type, payload: payload },
      window.location.origin
    );
  }

  // -------- 路由判断 --------
  function isConsolePage() {
    return /dev_tools\/console/.test(location.hash) || /\/app\/dev_tools/.test(location.pathname);
  }

  // -------- 版本兼容检测（判据 A：编辑器类型探测） --------
  // 设计：不因“暂时没找到编辑器”就判不支持（页面可能还在加载）。
  //   - 一旦出现 .conApp__output（Ace）   → resolve {ok:true}
  //   - 一旦出现 .monaco-editor（明确 Monaco）→ resolve {ok:false, editor:'monaco'}
  //   - 持续用 MutationObserver 观察 DOM，直到出现上述之一或超长兜底超时
  var compatResolved = false; // 防止多次 resolve / 重复初始化

  function detectCompatibility(maxWaitMs) {
    maxWaitMs = maxWaitMs || 20000; // 兜底：极端情况下最多等 20s
    return new Promise(function (resolve) {
      function settle(result) {
        if (compatResolved) return;
        compatResolved = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      function check() {
        if (document.querySelector('.conApp__output')) {
          settle({ ok: true, editor: 'ace' });
          return true;
        }
        if (document.querySelector('.monaco-editor')) {
          var version = (document.querySelector('meta[name="kbn-version"]') || {}).content || '未知';
          settle({ ok: false, editor: 'monaco', version: version });
          return true;
        }
        return false;
      }

      // 先立即检查一次
      if (check()) return;

      // DOM 变化时再检查（覆盖异步渲染：Dev Tools 加载、用户首次进入 Console 等）
      var observer = new MutationObserver(function () { check(); });
      try {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { /* ignore */ }

      // 兜底超时：长时间既无 Ace 也无 Monaco，才判未知不支持（仅一次）
      var timer = setTimeout(function () {
        var version = (document.querySelector('meta[name="kbn-version"]') || {}).content || '未知';
        var editor = document.querySelector('.monaco-editor') ? 'monaco' : 'unknown';
        settle({ ok: false, editor: editor, version: version });
      }, maxWaitMs);
    });
  }

  // -------- 注入 MAIN world 脚本 --------
  function injectMainWorldScript() {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/injected.js');
    s.onload = function () { s.remove(); };
    (document.head || document.documentElement).appendChild(s);
  }

  // -------- 处理点击命中 --------
  function handleClick(payload) {
    if (!KFE.locate) return;
    // 弹窗打开期间忽略结果区点击（模态语义）
    if (KFE.modal && KFE.modal.isOpen && KFE.modal.isOpen()) return;

    var ctx = KFE.locate(payload.fullText, payload.offset);
    if (!ctx) {
      KFE.floatButton && KFE.floatButton.hide();
      return;
    }
    lastCtx = ctx;

    KFE.floatButton.show({
      pageX: payload.screen.pageX,
      pageY: payload.screen.pageY,
      lineHeight: payload.lineHeight,
      onClick: function () { openEditModal(ctx); }
    });
  }

  // -------- 打开编辑弹窗 --------
  function openEditModal(ctx) {
    var originalText = KFE.toDisplayText(ctx.originalValue, ctx.valueType);
    var tip = null;
    if (ctx.valueType !== 'array' && ctx.originalValue === null) {
      tip = '原值为 null，将根据输入内容自动推断类型';
    } else if (ctx.valueType === 'array') {
      tip = '数组将被整体替换，请输入合法 JSON 数组';
    }

    KFE.modal.open({
      fieldPath: ctx.displayPath || ctx.fieldPath,
      originalText: originalText,
      valueType: ctx.valueType,
      tip: tip,
      onConfirm: function (inputText) { return submit(ctx, inputText); }
    });
  }

  // -------- 提交更新 --------
  async function submit(ctx, inputText) {
    // 0. 文档定位前置校验
    if (!ctx._index || !ctx._id) {
      KFE.modal.showError('无法定位文档：缺少 _index 或 _id（该 hit 可能不包含元数据）');
      return;
    }

    // 1. 类型转换
    var newValue;
    try {
      newValue = KFE.convertByType(ctx.originalValue, inputText, ctx.valueType);
    } catch (e) {
      KFE.modal.showError(e.message);
      return;
    }

    // 2. 提交：根据 updateMode 选择 doc 部分更新或 painless script 更新
    KFE.modal.setLoading(true);
    var resp;
    if (ctx.updateMode === 'script') {
      // 数组内对象字段：用 painless 精准更新（含数组下标）
      resp = await KFE.updateByScript(ctx._index, ctx._id, ctx.painlessPath, newValue);
    } else {
      // 顶层/嵌套标量、顶层数组整体：doc 部分更新
      resp = await KFE.updateField(ctx._index, ctx._id, ctx.fieldPath, newValue);
    }
    KFE.modal.setLoading(false);

    // 3. 处理结果
    if (resp.ok) {
      KFE.modal.showResult(resp.json, false);
      // 通知 injected 局部替换 Ace 文本
      var newText = KFE.serialize(newValue, ctx.valueType);
      postToInjected('REPLACE', {
        startOffset: ctx.valueRange.startOffset,
        endOffset: ctx.valueRange.endOffset,
        newText: newText
      });
    } else {
      KFE.modal.showResult(resp.json, true);
      // 失败不动 Ace 编辑器
    }
  }

  // -------- 消息监听（来自 injected） --------
  function bindMessages() {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || d.source !== MSG_FROM_INJECTED) return;

      if (d.type === 'CLICK') {
        handleClick(d.payload);
      } else if (d.type === 'SCROLL') {
        // 结果区滚动：隐藏浮层（弹窗打开时不受影响）
        KFE.floatButton && KFE.floatButton.hide();
      } else if (d.type === 'READY') {
        injectedReady = true;
      } else if (d.type === 'REPLACED') {
        if (!d.payload || !d.payload.ok) {
          console.warn('[KFE] Ace 文本替换失败：', d.payload && d.payload.message);
        }
      } else if (d.type === 'ERROR') {
        console.debug('[KFE] injected error:', d.payload);
      }
    });
  }

  // -------- 初始化 --------
  async function initFeature() {
    if (initialized) {
      // 已初始化，仅提醒 injected 重新绑定（路由切回时结果区可能重建）
      postToInjected('PING', {});
      return;
    }
    initialized = true;

    bindMessages();
    injectMainWorldScript();

    // 异步获取版本（仅用于日志）
    try {
      esVersion = await KFE.getVersion();
      console.info('[KFE] 已就绪。ES 版本：' + (esVersion || '未知'));
    } catch (e) { /* ignore */ }
  }

  // -------- 启动 --------
  var bootstrapStarted = false; // 防止 hashchange 多次触发重复检测/重复 observer

  async function bootstrap() {
    if (!isConsolePage()) return;   // 非 Console 页静默
    if (bootstrapStarted) {         // 已在检测/已激活，切回时只提醒重绑
      if (initialized) postToInjected('PING', {});
      return;
    }
    bootstrapStarted = true;

    var compat = await detectCompatibility();
    if (compat.ok) {
      await initFeature();
      return;
    }

    // 不支持：仅当“明确检测到 Monaco”时提示用户；unknown（多为加载异常）只用 debug 日志，不打扰
    if (compat.editor === 'monaco') {
      console.info(
        '[Kibana Field Editor] 当前环境不受支持，插件未激活。' +
        '（检测到 Monaco 编辑器；Kibana 版本: ' + (compat.version || '未知') + '）' +
        ' 本插件当前仅支持基于 Ace Editor 的 Kibana（约 7.5.x，<7.11）。'
      );
    } else {
      console.debug(
        '[Kibana Field Editor] 等待超时未检测到结果区编辑器，插件未激活。' +
        '若你确在 Dev Tools Console，请刷新页面重试。'
      );
    }
    // 允许后续 hashchange 再次尝试（例如用户离开又回到 Console）
    bootstrapStarted = false;
    compatResolved = false;
  }

  // SPA 路由切换：切到 Console 时尝试初始化
  window.addEventListener('hashchange', function () {
    if (isConsolePage()) {
      bootstrap();
    } else {
      // 离开 Console：隐藏浮层
      KFE.floatButton && KFE.floatButton.hide();
    }
  });

  bootstrap();
})();
