/**
 * convert.js — 按原值类型转换用户输入（运行在 content.js 的 isolated world）
 *
 * 暴露：
 *   window.__KFE.convertByType(originalValue, input, valueType) -> 转换后的 JS 值
 *     转换失败时抛出 Error（message 用于在弹窗内提示）
 *   window.__KFE.serialize(value, valueType) -> 用于写回 Ace 的 JSON 文本片段
 *   window.__KFE.toDisplayText(value, valueType) -> 弹窗默认显示文本
 */
(function () {
  'use strict';

  function convertByType(originalValue, input, valueType) {
    if (valueType === 'array') {
      var parsed;
      try {
        parsed = JSON.parse(input);
      } catch (e) {
        throw new Error('JSON 格式错误：' + e.message);
      }
      if (!Array.isArray(parsed)) {
        throw new Error('请输入合法的 JSON 数组（以 [ 开头、] 结尾）');
      }
      return parsed;
    }

    var t = originalValue === null ? 'null' : typeof originalValue;
    var v = input;

    switch (t) {
      case 'number': {
        var s = v.trim();
        var num = Number(s);
        if (s === '' || Number.isNaN(num)) {
          throw new Error('请输入合法数字');
        }
        return num;
      }
      case 'boolean': {
        var b = v.trim().toLowerCase();
        if (b === 'true') return true;
        if (b === 'false') return false;
        throw new Error('请输入 true 或 false');
      }
      case 'string':
        return v;
      case 'null': {
        // 智能推断（原值为 null，类型未知）
        var x = v.trim();
        if (x === 'null') return null;
        if (x.toLowerCase() === 'true') return true;
        if (x.toLowerCase() === 'false') return false;
        if (x !== '' && !Number.isNaN(Number(x))) return Number(x);
        return v;
      }
      default:
        return v;
    }
  }

  // 写回 Ace 文本片段：标量按 JSON 字面量序列化；数组整体序列化
  function serialize(value, valueType) {
    if (valueType === 'array') {
      return JSON.stringify(value);
    }
    return JSON.stringify(value); // 字符串会自动带引号，数字/布尔/null 为字面量
  }

  // 弹窗默认显示文本
  function toDisplayText(value, valueType) {
    if (valueType === 'array') {
      try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
    }
    if (value === null) return 'null';
    if (typeof value === 'string') return value; // 字符串直接显示内容（不带引号）
    return String(value);
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.convertByType = convertByType;
  window.__KFE.serialize = serialize;
  window.__KFE.toDisplayText = toDisplayText;
})();
