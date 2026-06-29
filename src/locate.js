/**
 * locate.js — JSON AST 解析 + 点击位置定位（运行在 content.js 的 isolated world）
 *
 * 不依赖任何第三方库：内置一个轻量 JSON 解析器，产出带 offset 范围的 AST 节点。
 * 节点结构：
 *   {
 *     type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null',
 *     start, end,                // 该节点值在全文中的字符偏移 [start, end)
 *     value,                     // 标量的 JS 值（object/array 不填）
 *     // object:
 *     members: [{ keyNode, valueNode }]
 *     // array:
 *     items: [valueNode]
 *   }
 *
 * keyNode 是字符串节点，额外带 start/end 指向 key（含引号）的范围。
 *
 * 暴露到 window.__KFE.locate。
 */
(function () {
  'use strict';

  // ---------------- 轻量 JSON 解析器 ----------------
  function parse(text) {
    var i = 0;
    var n = text.length;

    function err(msg) {
      throw new Error('JSON parse error at ' + i + ': ' + msg);
    }
    function skipWs() {
      while (i < n) {
        var c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
        else break;
      }
    }
    function parseValue() {
      skipWs();
      if (i >= n) err('unexpected end');
      var c = text[i];
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"') return parseString();
      if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
      if (text.substr(i, 4) === 'true') { var s = i; i += 4; return { type: 'boolean', value: true, start: s, end: i }; }
      if (text.substr(i, 5) === 'false') { var s2 = i; i += 5; return { type: 'boolean', value: false, start: s2, end: i }; }
      if (text.substr(i, 4) === 'null') { var s3 = i; i += 4; return { type: 'null', value: null, start: s3, end: i }; }
      err('unexpected char ' + c);
    }
    function parseString() {
      var start = i;

      // ES / Kibana Dev Tools 三引号长字符串： """ ... """ （内部无转义，可含换行/引号）
      if (text.substr(i, 3) === '"""') {
        i += 3; // 跳过开头 """
        var tStart = i;
        var idx = text.indexOf('"""', i);
        if (idx === -1) err('unterminated triple-quoted string');
        var tval = text.slice(tStart, idx);
        i = idx + 3; // 跳过结尾 """
        return { type: 'string', value: tval, start: start, end: i, triple: true };
      }

      i++; // 开引号
      var val = '';
      while (i < n) {
        var c = text[i];
        if (c === '\\') {
          var nx = text[i + 1];
          switch (nx) {
            case '"': val += '"'; break;
            case '\\': val += '\\'; break;
            case '/': val += '/'; break;
            case 'b': val += '\b'; break;
            case 'f': val += '\f'; break;
            case 'n': val += '\n'; break;
            case 'r': val += '\r'; break;
            case 't': val += '\t'; break;
            case 'u':
              val += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16));
              i += 4;
              break;
            default: val += nx;
          }
          i += 2;
        } else if (c === '"') {
          i++; // 闭引号
          return { type: 'string', value: val, start: start, end: i };
        } else {
          val += c;
          i++;
        }
      }
      err('unterminated string');
    }
    function parseNumber() {
      var start = i;
      if (text[i] === '-') i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
      if (text[i] === '.') { i++; while (i < n && text[i] >= '0' && text[i] <= '9') i++; }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < n && text[i] >= '0' && text[i] <= '9') i++;
      }
      var raw = text.slice(start, i);
      return { type: 'number', value: Number(raw), start: start, end: i };
    }
    function parseObject() {
      var start = i;
      i++; // {
      var members = [];
      skipWs();
      if (text[i] === '}') { i++; return { type: 'object', members: members, start: start, end: i }; }
      while (i < n) {
        skipWs();
        if (text[i] !== '"') err('expected key string');
        var keyNode = parseString();
        skipWs();
        if (text[i] !== ':') err('expected colon');
        i++;
        var valueNode = parseValue();
        members.push({ keyNode: keyNode, valueNode: valueNode });
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        err('expected , or }');
      }
      return { type: 'object', members: members, start: start, end: i };
    }
    function parseArray() {
      var start = i;
      i++; // [
      var items = [];
      skipWs();
      if (text[i] === ']') { i++; return { type: 'array', items: items, start: start, end: i }; }
      while (i < n) {
        var v = parseValue();
        items.push(v);
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        err('expected , or ]');
      }
      return { type: 'array', items: items, start: start, end: i };
    }

    skipWs();
    var root = parseValue();
    return root;
  }

  // ---------------- 命中查找：offset → 命中节点链 ----------------
  // 返回从根到命中叶子的路径数组，每项 { node, key?, index?, isKey? }
  function findHitChain(root, offset) {
    var chain = [];

    function within(node) {
      return offset >= node.start && offset < node.end;
    }

    function walk(node, descriptor) {
      chain.push(Object.assign({ node: node }, descriptor || {}));
      if (node.type === 'object') {
        for (var m = 0; m < node.members.length; m++) {
          var mem = node.members[m];
          // 命中 key
          if (offset >= mem.keyNode.start && offset < mem.keyNode.end) {
            chain.push({ node: mem.keyNode, key: mem.keyNode.value, isKey: true, member: mem });
            return true;
          }
          // 命中 value 子树
          if (within(mem.valueNode)) {
            return walk(mem.valueNode, { key: mem.keyNode.value, member: mem });
          }
        }
      } else if (node.type === 'array') {
        for (var a = 0; a < node.items.length; a++) {
          if (within(node.items[a])) {
            return walk(node.items[a], { index: a });
          }
        }
      }
      return true; // 标量或落在容器空白处
    }

    if (!within(root)) return null;
    walk(root, {});
    return chain;
  }

  // ---------------- 路径工具 ----------------
  function getProp(objNode, key) {
    if (!objNode || objNode.type !== 'object') return null;
    for (var i = 0; i < objNode.members.length; i++) {
      if (objNode.members[i].keyNode.value === key) return objNode.members[i].valueNode;
    }
    return null;
  }

  // 由命中链推出 key 的层级（用于判断是否在 _source 内、组装字段点号路径）
  function buildKeyPath(chain) {
    var keys = [];
    for (var i = 0; i < chain.length; i++) {
      var c = chain[i];
      if (c.key !== undefined && !c.isKey) keys.push({ type: 'key', value: c.key });
      else if (c.index !== undefined) keys.push({ type: 'index', value: c.index });
      else if (c.isKey) keys.push({ type: 'key', value: c.key, isKeyHit: true });
    }
    return keys;
  }

  /**
   * 主入口：根据全文与点击 offset，判断是否命中可编辑字段。
   * 返回 null 表示不触发；否则返回：
   * {
   *   _id, _index,
   *   fieldPath,           // 相对 _source 的点号路径，如 'user.name' 或 'tags'
   *   valueType,           // 'scalar' | 'array'
   *   originalValue,       // 原值（JS 值）；数组为整个数组
   *   valueRange: { startOffset, endOffset },  // 用于替换的范围
   *   row                  // 命中行（0-based），用于浮层定位（由调用方结合 pos 提供）
   * }
   */
  function locate(fullText, offset) {
    var root;
    try {
      root = parse(fullText);
    } catch (e) {
      return null;
    }

    var chain = findHitChain(root, offset);
    if (!chain || chain.length === 0) return null;

    var keyPath = buildKeyPath(chain);

    // 找到 _source 在 keyPath 中的位置
    var srcIdx = -1;
    for (var i = 0; i < keyPath.length; i++) {
      if (keyPath[i].type === 'key' && keyPath[i].value === '_source') { srcIdx = i; break; }
    }
    if (srcIdx === -1) return null; // 不在任何 _source 内

    // 校验 _source 的祖先是 hits.hits[N]
    // keyPath 形如: [hits(key), hits(key), index, _source(key), ...field...]
    // 这里宽松校验：_source 前需要存在一个 index（数组下标），再往前是 'hits'
    var idxBefore = null;
    for (var j = srcIdx - 1; j >= 0; j--) {
      if (keyPath[j].type === 'index') { idxBefore = keyPath[j].value; break; }
    }
    if (idxBefore === null) return null; // _source 不在数组元素下，非标准 hits 结构

    // 定位到对应的 hit 对象节点（hits.hits[idxBefore]）
    var hitsTop = getProp(root, 'hits');
    var hitsArr = getProp(hitsTop, 'hits');
    if (!hitsArr || hitsArr.type !== 'array') return null;
    var hitNode = hitsArr.items[idxBefore];
    if (!hitNode || hitNode.type !== 'object') return null;

    var idNode = getProp(hitNode, '_id');
    var indexNode = getProp(hitNode, '_index');
    var _id = idNode ? idNode.value : null;
    var _index = indexNode ? indexNode.value : null;

    var sourceNode = getProp(hitNode, '_source');
    if (!sourceNode) return null;

    // ---- 计算命中目标 ----
    // 取 _source 之后的子路径（segs：{type:'key'|'index', value}）
    var fieldSeg = keyPath.slice(srcIdx + 1); // 不含 _source

    // 命中链最后一个 chain 项对应的节点
    var lastChain = chain[chain.length - 1];
    var hitNodeLeaf = lastChain.node;

    // 情况判定
    var lastSeg = fieldSeg[fieldSeg.length - 1];

    // A. 命中 key 名 → 取其 value 决定行为
    if (lastChain.isKey) {
      var valNode = lastChain.member.valueNode;
      if (isScalar(valNode)) {
        return buildScalarResult(_id, _index, fieldSeg, valNode);
      }
      // value 是对象/数组 → 不触发（MVP）
      return null;
    }

    // B. 命中标量值
    if (isScalar(hitNodeLeaf)) {
      // B1. 命中的是数组中“直接的标量元素”（如 tags[0]）→ 整数组编辑
      if (lastSeg && lastSeg.type === 'index') {
        var arrNode = findArrayAncestor(chain);
        if (!arrNode) return null;
        var arrFieldSeg = fieldSeg.slice(0, fieldSeg.length - 1); // 去掉最后的 index
        return buildArrayResult(_id, _index, arrFieldSeg, arrNode);
      }
      // B2. 命中标量（可能在数组对象内，如 WorkExperienceList[0].StartDate）→ 标量更新
      //     是否在数组内由 fieldSeg 是否含 index 决定（buildScalarResult 内判断）
      return buildScalarResult(_id, _index, fieldSeg, hitNodeLeaf);
    }

    // C. 命中数组节点本身（点在数组的 [ ] 或空白）→ 整数组编辑
    if (hitNodeLeaf.type === 'array') {
      return buildArrayResult(_id, _index, fieldSeg, hitNodeLeaf);
    }

    // D. 命中对象节点 → 不触发（MVP）
    return null;
  }

  function isScalar(node) {
    return node && (node.type === 'string' || node.type === 'number' ||
      node.type === 'boolean' || node.type === 'null');
  }

  function findArrayAncestor(chain) {
    for (var i = chain.length - 1; i >= 0; i--) {
      if (chain[i].node.type === 'array') return chain[i].node;
    }
    return null;
  }

  // segs 是否包含数组下标
  function segsHaveIndex(segs) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type === 'index') return true;
    }
    return false;
  }

  // 纯点号路径（仅 key），用于 doc 部分更新（无数组场景）
  function segsToDotPath(segs) {
    var parts = [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type === 'key') parts.push(segs[i].value);
    }
    return parts.join('.');
  }

  // painless 访问路径，含数组下标，如 WorkExperienceList[0].StartDate
  // 仅用于 script 更新；key 用方括号字面量访问以兼容特殊字符（点、空格等）
  function segsToPainless(segs) {
    var expr = 'ctx._source';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === 'index') {
        expr += '[' + s.value + ']';
      } else {
        // 用 ['key'] 形式访问，避免 key 含点/特殊字符时被误解析
        expr += "['" + String(s.value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
      }
    }
    return expr;
  }

  // 人类可读的字段路径（用于弹窗显示），如 WorkExperienceList[0].StartDate
  function segsToDisplayPath(segs) {
    var str = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === 'index') str += '[' + s.value + ']';
      else str += (str ? '.' : '') + s.value;
    }
    return str;
  }

  // 标量字段结果：根据是否含数组下标决定 updateMode = 'doc' | 'script'
  function buildScalarResult(_id, _index, fieldSeg, valueNode) {
    var hasIndex = segsHaveIndex(fieldSeg);
    return {
      _id: _id,
      _index: _index,
      updateMode: hasIndex ? 'script' : 'doc',
      fieldPath: segsToDotPath(fieldSeg),       // doc 模式用
      painlessPath: segsToPainless(fieldSeg),   // script 模式用
      displayPath: segsToDisplayPath(fieldSeg),
      valueType: 'scalar',
      originalValue: nodeToValue(valueNode),
      valueRange: { startOffset: valueNode.start, endOffset: valueNode.end }
    };
  }

  // 整数组结果：根据数组本身是否在更深的数组内决定 doc | script
  function buildArrayResult(_id, _index, fieldSeg, arrayNode) {
    var hasIndex = segsHaveIndex(fieldSeg);
    return {
      _id: _id,
      _index: _index,
      updateMode: hasIndex ? 'script' : 'doc',
      fieldPath: segsToDotPath(fieldSeg),
      painlessPath: segsToPainless(fieldSeg),
      displayPath: segsToDisplayPath(fieldSeg),
      valueType: 'array',
      originalValue: nodeToValue(arrayNode),
      valueRange: { startOffset: arrayNode.start, endOffset: arrayNode.end }
    };
  }

  // 把 AST 节点还原成 JS 值（用于原始值显示与类型判断）
  function nodeToValue(node) {
    if (isScalar(node)) return node.value;
    if (node.type === 'array') {
      return node.items.map(nodeToValue);
    }
    if (node.type === 'object') {
      var o = {};
      node.members.forEach(function (m) { o[m.keyNode.value] = nodeToValue(m.valueNode); });
      return o;
    }
    return null;
  }

  window.__KFE = window.__KFE || {};
  window.__KFE.locate = locate;
  window.__KFE._parseJSON = parse; // 便于调试/测试
})();
