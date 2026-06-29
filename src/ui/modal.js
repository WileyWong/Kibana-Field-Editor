/**
 * modal.js — “修改字段值”模态弹窗（带遮罩，Shadow DOM 隔离）
 *
 * 暴露：
 *   window.__KFE.modal.open({
 *     fieldPath, originalText, valueType,
 *     onConfirm: async (inputText) => {}   // 由调用方处理类型转换 + 提交
 *   })
 *   window.__KFE.modal.setLoading(bool)
 *   window.__KFE.modal.showResult(jsonObj, isError)
 *   window.__KFE.modal.showError(message)
 *   window.__KFE.modal.close()
 */
(function () {
  'use strict';

  var host = null, shadow = null;
  var els = {};
  var state = { originalText: '', onConfirm: null };

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'kfe-modal-host';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      '*{box-sizing:border-box;font-family:Segoe UI,Helvetica,Arial,sans-serif;}' +
      '.mask{position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483647;' +
      'display:flex;align-items:center;justify-content:center;}' +
      '.dlg{width:520px;max-width:92vw;max-height:88vh;overflow:auto;background:#fff;' +
      'border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.3);padding:0;}' +
      '.hd{display:flex;align-items:center;justify-content:space-between;' +
      'padding:14px 18px;border-bottom:1px solid #eee;}' +
      '.hd h3{margin:0;font-size:16px;color:#1a1a1a;}' +
      '.x{cursor:pointer;font-size:20px;color:#888;line-height:1;border:none;background:none;}' +
      '.x:hover{color:#333;}' +
      '.bd{padding:16px 18px;}' +
      '.path{font-size:12px;color:#666;background:#f5f7fa;border-radius:4px;' +
      'padding:6px 8px;margin-bottom:10px;word-break:break-all;font-family:Consolas,monospace;}' +
      '.tip{font-size:12px;color:#b8860b;margin-bottom:8px;}' +
      'textarea{width:100%;min-height:90px;resize:vertical;font-size:13px;' +
      'font-family:Consolas,monospace;padding:8px;border:1px solid #ccc;border-radius:4px;}' +
      'textarea:focus{outline:none;border-color:#006bb4;}' +
      '.err{color:#bd271e;font-size:12px;margin-top:8px;min-height:16px;}' +
      '.status{margin-top:12px;padding:8px 12px;border-radius:4px;font-size:14px;' +
      'font-weight:600;display:none;}' +
      '.status.ok{background:#e6f4ea;color:#1e7e34;border:1px solid #a3d9b1;}' +
      '.status.bad{background:#fdecea;color:#bd271e;border:1px solid #f1aeb5;}' +
      '.result{margin-top:8px;}' +
      '.result pre{background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:4px;' +
      'font-size:12px;font-family:Consolas,monospace;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;}' +
      '.result.ok pre{border-left:3px solid #2e7d32;}' +
      '.result.bad pre{border-left:3px solid #bd271e;}' +
      '.ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #eee;}' +
      'button.act{padding:6px 16px;font-size:13px;border-radius:4px;cursor:pointer;border:1px solid transparent;}' +
      'button.cancel{background:#fff;border-color:#ccc;color:#333;}' +
      'button.cancel:hover{background:#f5f5f5;}' +
      'button.ok{background:#006bb4;color:#fff;}' +
      'button.ok:hover{background:#005a99;}' +
      'button.ok:disabled{background:#a8c7dd;cursor:not-allowed;}' +
      '.spin{display:inline-block;width:12px;height:12px;border:2px solid #fff;' +
      'border-top-color:transparent;border-radius:50%;animation:r .7s linear infinite;margin-right:6px;vertical-align:-1px;}' +
      '@keyframes r{to{transform:rotate(360deg);}}';
    shadow.appendChild(style);

    var mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML =
      '<div class="dlg" role="dialog" aria-modal="true">' +
      '  <div class="hd"><h3>修改字段值</h3><button class="x" title="关闭">&times;</button></div>' +
      '  <div class="bd">' +
      '    <div class="path"></div>' +
      '    <div class="tip" style="display:none;"></div>' +
      '    <textarea spellcheck="false"></textarea>' +
      '    <div class="err"></div>' +
      '    <div class="status"></div>' +
      '    <div class="result" style="display:none;"><pre></pre></div>' +
      '  </div>' +
      '  <div class="ft">' +
      '    <button class="act cancel">取消</button>' +
      '    <button class="act ok" disabled>确认</button>' +
      '  </div>' +
      '</div>';
    shadow.appendChild(mask);

    els.mask = mask;
    els.dlg = mask.querySelector('.dlg');
    els.path = mask.querySelector('.path');
    els.tip = mask.querySelector('.tip');
    els.textarea = mask.querySelector('textarea');
    els.err = mask.querySelector('.err');
    els.status = mask.querySelector('.status');
    els.result = mask.querySelector('.result');
    els.resultPre = mask.querySelector('.result pre');
    els.btnOk = mask.querySelector('button.ok');
    els.btnCancel = mask.querySelector('button.cancel');
    els.btnX = mask.querySelector('.x');

    // 事件
    els.btnX.addEventListener('click', close);
    els.btnCancel.addEventListener('click', close);
    // 模态：点击遮罩不关闭（避免误触丢失输入），仅按钮/×关闭
    els.textarea.addEventListener('input', onInput);
    els.btnOk.addEventListener('click', onConfirmClick);
  }

  function onInput() {
    els.err.textContent = '';
    var changed = els.textarea.value !== state.originalText;
    els.btnOk.disabled = !changed;
  }

  async function onConfirmClick() {
    if (els.btnOk.disabled) return;
    els.err.textContent = '';
    if (state.onConfirm) {
      await state.onConfirm(els.textarea.value);
    }
  }

  function open(opts) {
    build();
    state.originalText = opts.originalText || '';
    state.onConfirm = opts.onConfirm || null;

    els.path.textContent = opts.fieldPath
      ? ('字段路径：_source.' + opts.fieldPath + (opts.valueType === 'array' ? '（数组，整体编辑）' : ''))
      : '';
    if (opts.tip) {
      els.tip.style.display = 'block';
      els.tip.textContent = opts.tip;
    } else {
      els.tip.style.display = 'none';
    }
    els.textarea.value = state.originalText;
    els.textarea.disabled = false;
    els.err.textContent = '';
    els.status.style.display = 'none';
    els.status.className = 'status';
    els.status.textContent = '';
    els.result.style.display = 'none';
    els.result.className = 'result';
    els.resultPre.textContent = '';
    els.btnOk.disabled = true;
    els.btnOk.innerHTML = '确认';
    els.btnCancel.style.display = '';

    host.style.display = 'block';
    setTimeout(function () { els.textarea.focus(); }, 0);
  }

  function setLoading(loading) {
    if (!host) return;
    els.btnOk.disabled = loading;
    els.textarea.disabled = loading;
    els.btnOk.innerHTML = loading ? '<span class="spin"></span>提交中' : '确认';
  }

  function showError(message) {
    if (!host) return;
    els.err.textContent = message || '';
  }

  // 展示 ES 返回结果（成功/失败）
  function showResult(jsonObj, isError) {
    if (!host) return;
    // 顶部状态条：成功绿色 / 失败红色
    els.status.style.display = 'block';
    els.status.className = 'status ' + (isError ? 'bad' : 'ok');
    els.status.textContent = isError ? '修改失败' : '修改成功';

    // ES 原始返回
    els.result.style.display = 'block';
    els.result.className = 'result ' + (isError ? 'bad' : 'ok');
    var text;
    try { text = JSON.stringify(jsonObj, null, 2); } catch (e) { text = String(jsonObj); }
    els.resultPre.textContent = text;
    // 提交完成后：确认按钮恢复但禁用（已提交），用户手动关闭
    els.btnOk.innerHTML = '确认';
    els.btnOk.disabled = true;
    els.textarea.disabled = true;
  }

  function close() {
    if (host) host.style.display = 'none';
    state.onConfirm = null;
  }

  function isOpen() {
    return host && host.style.display === 'block';
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.modal = {
    open: open,
    setLoading: setLoading,
    showResult: showResult,
    showError: showError,
    close: close,
    isOpen: isOpen
  };
})();
