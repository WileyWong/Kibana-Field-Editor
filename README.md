# Kibana Field Editor

> 在 Kibana Dev Tools 里查完数据后，**点一下就能改**，不用再手写 `_update` 了。

## 这玩意解决什么问题？

用 Kibana Dev Tools 测试 ES 数据时，你大概率经历过这个流程：

```
查数据：GET /order/_search          ← 很快
发现某个字段值不对，想改一下
手写：POST /order/_update/abc123    ← 开始烦躁
      { "doc": { "status": 1 } }
      切回结果区找 _id，复制粘贴……
```

如果只是偶尔改一两条，还好。但**调试造数/修脏数据的时候**，写完查、查完改、来回切，非常打断思路。

这个插件做的事：

```
查数据 → 点一下要改的字段 → 输入新值 → 确认
                                     ↓
                              自动拼 _update、调接口、刷新结果
```

**适合的场景：**
- 测试时临时造/修几条数据
- 查出来后顺手纠正一个字段
- 调试时反复调整某个值看效果

**不适合的场景：**
- 批量修改几百条文档 → 写 `_update_by_query` 脚本更合适
- 改完要回滚 → 当前 MVP 不提供撤销

---

## 支持的版本

Kibana 在 **8.16** 把 Dev Tools Console 的编辑器从 Ace 换成了 Monaco（见 [Elastic 官方博客](https://www.elastic.co/blog/dev-tools-console-kibana)）。
插件对两种编辑器都做了适配，**全版本可用**，只是 Monaco 版有一点体验差异（见下表）。

| Kibana 版本 | 编辑器 | 支持？ | 说明 |
|-------------|--------|:-----:|------|
| **7.x（含 7.5 ~ 7.17）** | Ace Editor | ✅ | 实测 7.5.1、7.17.x 均可用 |
| **8.0 ~ 8.15** | Ace Editor | ✅ | 仍是 Ace，完整支持 |
| **8.16+（含 8.17.x）** | **Monaco Editor** | ✅ | 已适配（实测 8.17.3）。**差异**：修改成功后结果区不会就地刷新，需**重新执行查询**查看最新值（弹窗会提示） |

> **两种版本的实现差异**（了解即可，使用无感）：
> - **Ace 版**：直接复用页面 `window.ace` 实例，能拿全文、能就地回写结果区。
> - **Monaco 版**：Monaco 实例不可达，改用「拦截 `_search` 网络响应拿完整 JSON + DOM 点击定位」；因 Monaco 结果区只读且虚拟渲染，**更新成功后不就地回写**，需重新查询。

> **怎么看自己的 Kibana 用的是什么编辑器？**（最准，不用记版本号）
> 打开 Dev Tools 页面，F12 → Elements 面板搜索 `conApp__output`（Ace 版，< 8.16）或 `consoleMonacoOutput`（Monaco 版，8.16+）。两者插件都支持。

---

## 长什么样

```
 Kibana Dev Tools | 请求区                  | 结果区（Ace Editor）
                  | GET /order/_search       | {
                  |                          |   "hits": {
                  |                          |     "hits": [{
                  |                          |       "_id": "abc123",
                  |                          |       "_source": {
                  |                          |         "status": 1,  ← 点这里
                  |                          |         "name": "xxx"
                  |                          |       }
                  |                          |     }]
                  |                          |   }
                  |                          | }
                  |                          |         [+修改值] ← 浮层出现
                  |                          |
                  |                          |  ┌─────────────────┐
                  |                          |  │ 修改字段值        │
                  |                          |  │ hits.hits[0].    │
                  |                          |  │ _source.status   │
                  |                          |  │ [ 2        ]     │
                  |                          |  │    [确认] [取消]  │
                  |                          |  └─────────────────┘
```

---

## 怎么装

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本项目根目录（就是 `manifest.json` 所在的那个目录）
5. 搞定，不需要构建

---

## 怎么用

1. 打开 Kibana 的 Dev Tools（`/app/kibana#/dev_tools/console`）
2. 跑一条 `_search`
3. 在右侧结果区，**直接点击**你想改的字段值
4. 行尾出现「修改值」→ 点它
5. 输入新值 → 点确认 → 完事

支持改什么：字符串、数字、布尔、null、整个数组（JSON 格式）。

---

## 目录结构

```
kibana-extention/
├── manifest.json             # Chrome 扩展清单（MV3）
├── README.md
├── docs/                     # 需求文档 & 方案文档
│   ├── 需求文档.md
│   ├── 方案文档.md
│   └── 审查报告.md
├── public/                   # 扩展图标等静态资源
└── src/
    ├── content.js            # 主入口：路由检测、流程编排、消息调度
    ├── injected.js           # 注入到页面的桥接脚本，操作 Ace Editor
    ├── locate.js             # JSON AST 解析 → 确定点击的是哪个字段
    ├── convert.js            # 按原字段类型转换用户输入
    ├── proxy.js              # 通过 Kibana proxy 调用 ES _update
    └── ui/
        ├── floatButton.js    # 「修改值」浮层按钮
        └── modal.js          # 修改弹窗
```

---

## 调试

- 打开 F12 Console，看到 `[KFE] 已就绪` 说明插件正常激活
- 在非支持版本上打开，Console 里会看到 `[Kibana Field Editor] 当前环境不受支持…` 的提示
- 改了代码 → `chrome://extensions/` 点扩展的刷新按钮 → 刷新 Kibana 页面
- 点击没反应？确认点的是 `_source` 下的字段值，不是 `_id`、`_index` 等元数据

---

## 限制（MVP）

| 能做 | 不做 |
|------|------|
| 改标量字段（string/number/bool/null） | 编辑整个嵌套对象 |
| 编辑整个数组 | 批量修改多条文档 |
| 数组内对象字段（painless 精准更新） | 操作日志 / 撤销回滚 |
| 单条点击修改 | Monaco 版（8.16+）成功后就地回写结果区（需重新查询） |
| 全版本支持（Ace 与 Monaco） | |
