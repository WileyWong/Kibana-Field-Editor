# Kibana Field Editor

> Click to edit `_source` fields directly in Kibana Dev Tools — no more hand-writing `_update` requests.

## What problem does this solve?

When testing ES data in Kibana Dev Tools, you've probably done this dance:

```
Search:  GET /order/_search              ← fast
Spot a wrong value, want to fix it
Hand-write: POST /order/_update/abc123   ← frustrating
            { "doc": { "status": 1 } }
            Switch back to find _id, copy, paste…
```

This extension collapses that flow to:

```
Search → click the field → type new value → confirm
                                    ↓
                         auto-builds _update, calls ES, shows result
```

**Good for:**
- Quick data fixes while testing
- Correcting a field right after searching
- Iterating on a value while debugging

**Not for:**
- Bulk-updating hundreds of docs → use `_update_by_query` instead
- Needing rollback → MVP, no undo

---

## Supported versions

Kibana switched its Dev Tools Console editor from **Ace** to **Monaco** in **8.16** ([Elastic blog](https://www.elastic.co/blog/dev-tools-console-kibana)).
This extension supports **both editors** across all versions, with one UX difference for Monaco (see table).

| Kibana version | Editor | Supported? | Notes |
|---------------|--------|:---------:|-------|
| **7.x (7.5 – 7.17)** | Ace Editor | ✅ | Tested on 7.5.1, 7.17.x |
| **8.0 – 8.15** | Ace Editor | ✅ | Still Ace, full support |
| **8.16+ (including 8.17.x)** | **Monaco Editor** | ✅ | Tested on 8.17.3. **Difference**: after updating, the result panel does **not** refresh in-place — re-run the query to see the latest value (the modal will remind you). |

> **Implementation differences** (transparent to the user):
> - **Ace mode**: directly reuses the page's `window.ace` instance. Full text access, in-place result replacement.
> - **Monaco mode**: the Monaco instance is not exposed, so we use "intercept `_search` fetch + DOM click positioning" instead. Because Monaco's result panel is read-only and uses virtual rendering, in-place replacement is not possible — a re-query is needed.

> **How to tell which editor your Kibana uses?** (most reliable, no version number needed)
> Open Dev Tools, F12 → Elements panel, search for `conApp__output` (Ace, < 8.16) or `consoleMonacoOutput` (Monaco, 8.16+). The extension supports both.

---

## How it looks

```
 Kibana Dev Tools | Request panel           | Result panel
                  | GET /order/_search       | {
                  |                          |   "hits": {
                  |                          |     "hits": [{
                  |                          |       "_id": "abc123",
                  |                          |       "_source": {
                  |                          |         "status": 1,  ← click here
                  |                          |         "name": "xxx"
                  |                          |       }
                  |                          |     }]
                  |                          |   }
                  |                          | }
                  |                          |       [+Edit] ← float button appears
                  |                          |
                  |                          |  ┌─────────────────┐
                  |                          |  │ Edit Field Value │
                  |                          |  │ hits.hits[0].    │
                  |                          |  │ _source.status   │
                  |                          |  │ [ 2        ]     │
                  |                          |  │  [Confirm][Cancel]│
                  |                          |  └─────────────────┘
```

---

## Installation

1. Open Chrome, go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the project **root directory** (the one containing `manifest.json`)
5. Done — no build step required

---

## Usage

1. Open Kibana's Dev Tools (`/app/kibana#/dev_tools/console`)
2. Run a `_search`
3. In the right-hand result panel, **click** the field value you want to edit
4. A semi-transparent **"Edit"** button appears at the end of the line → click it
5. Enter the new value → click Confirm → done

Supported field types: strings, numbers, booleans, null, entire arrays (as JSON).

---

## Directory structure

```
kibana-extention/
├── manifest.json              # Chrome extension manifest (MV3)
├── README.md
├── README_CN.md               # Chinese version
├── docs/                      # Design & review docs
│   ├── 需求文档.md
│   ├── 方案文档.md
│   └── 审查报告.md
└── src/
    ├── content.js             # ISOLATED world: routing, editor detection, message orchestration
    ├── injected.js            # MAIN world: Ace adapter (< 8.16), uses window.ace
    ├── injected-monaco.js     # MAIN world: Monaco adapter (8.16+), hook fetch + DOM positioning
    ├── locate.js              # JSON AST parser → offset-based field location (shared)
    ├── locate-dom.js          # Monaco: line-text → offset conversion, reuses locate.js
    ├── convert.js             # Type-aware value conversion (shared)
    ├── proxy.js               # Kibana proxy caller for ES _update (shared)
    └── ui/
        ├── floatButton.js     # "Edit" float button (shared)
        └── modal.js           # Edit modal dialog (shared)
```

---

## Debugging

- Open F12 Console; seeing `[KFE] 已就绪` means the extension is active
- Code change → click the refresh button on the extension in `chrome://extensions/` → refresh the Kibana page
- Click not responding? Make sure you're clicking a field value under `_source`, not `_id`, `_index`, or other metadata
- If the edit button doesn't appear on Monaco (8.16+), run the `_search` once so the extension can cache the response, then click again

---

## Limitations (MVP)

| Can do | Won't do |
|--------|----------|
| Edit scalar fields (string/number/bool/null) | Edit entire nested objects |
| Edit entire arrays | Bulk-update multiple docs |
| Edit fields inside array objects (painless precise update) | Operation log / undo |
| Single-click edits | In-place result refresh on Monaco (8.16+) — re-query needed |
| All Kibana versions (Ace & Monaco) | |
