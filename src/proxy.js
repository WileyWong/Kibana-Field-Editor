/**
 * proxy.js — 通过 Kibana console proxy 调用 ES（运行在 content.js 的 isolated world）
 *
 * 复用浏览器已有的 Kibana session cookie，带 kbn-xsrf 头。
 *
 * 暴露：
 *   window.__KFE.callProxy(path, method, body) -> Promise<{ ok, status, json }>
 *   window.__KFE.updateField(index, id, fieldPath, value) -> Promise<{ ok, status, json }>
 *   window.__KFE.getVersion() -> Promise<string|null>
 */
(function () {
  'use strict';

  async function callProxy(path, method, body) {
    var url = '/api/console/proxy?path=' + encodeURIComponent(path) +
      '&method=' + encodeURIComponent(method);
    var res;
    try {
      res = await fetch(url, {
        method: 'POST', // Kibana console proxy 统一用 POST 承载
        headers: {
          'Content-Type': 'application/json',
          'kbn-xsrf': 'true'
        },
        credentials: 'include',
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      return { ok: false, status: 0, json: { error: { reason: '网络请求失败：' + String(e) } } };
    }

    var json = null;
    try { json = await res.json(); } catch (e) { json = {}; }

    var ok = res.ok && !(json && json.error);
    return { ok: ok, status: res.status, json: json };
  }

  function buildUpdatePath(index, id) {
    return '/' + encodeURIComponent(index) + '/_update/' + encodeURIComponent(id);
  }

  function missingDoc(index, id) {
    if (!index || !id) {
      return {
        ok: false, status: 0,
        json: { error: { reason: '无法定位文档：缺少 _index 或 _id' } }
      };
    }
    return null;
  }

  // doc 部分更新：用于无数组下标的顶层/嵌套标量字段（fieldPath 为点号路径）
  function updateField(index, id, fieldPath, value) {
    var miss = missingDoc(index, id);
    if (miss) return Promise.resolve(miss);
    var docPatch = {};
    docPatch[fieldPath] = value; // ES _update 支持点号路径作为嵌套字段 key
    return callProxy(buildUpdatePath(index, id), 'POST', { doc: docPatch });
  }

  // painless script 更新：用于数组内对象字段（含下标），如 ctx._source.list[0].field
  // 通过 params 传值，类型天然正确、无需手工转义
  function updateByScript(index, id, painlessPath, value) {
    var miss = missingDoc(index, id);
    if (miss) return Promise.resolve(miss);
    var body = {
      script: {
        lang: 'painless',
        source: painlessPath + ' = params.v',
        params: { v: value }
      }
    };
    return callProxy(buildUpdatePath(index, id), 'POST', body);
  }

  async function getVersion() {
    var r = await callProxy('/', 'GET');
    try {
      return r.json && r.json.version ? r.json.version.number : null;
    } catch (e) {
      return null;
    }
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.callProxy = callProxy;
  window.__KFE.updateField = updateField;
  window.__KFE.updateByScript = updateByScript;
  window.__KFE.getVersion = getVersion;
})();
