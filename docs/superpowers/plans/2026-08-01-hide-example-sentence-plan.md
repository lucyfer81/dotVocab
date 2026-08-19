# Hide Example Sentence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the English example sentence during the spelling test phase to prevent answer leaking.

**Architecture:** We will modify the HTML template in `public/app.js`'s `spellingCard` function to remove the line that renders the `w.example_en` variable.

**Tech Stack:** Vanilla JavaScript/HTML

## Global Constraints

- No additional dependencies.
- Changes should be minimal and restricted to `spellingCard` in `public/app.js`.

---

### Task 1: Update spellingCard function in app.js

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: The `w` object containing vocabulary details in `spellingCard`.
- Produces: A spelling card UI without the English example sentence.

- [ ] **Step 1: Write the minimal implementation (code edit)**

We will use the replace_file_content tool to remove the line `${w.example_en ? \`<div class="ex">$\{escapeHtml(w.example_en)}</div>\` : ""}` from the `spellingCard` template.

```javascript
// Remove this line from public/app.js inside the spellingCard template string:
// ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}</div>` : ""}
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "fix: hide english example sentence during spelling test"
```
