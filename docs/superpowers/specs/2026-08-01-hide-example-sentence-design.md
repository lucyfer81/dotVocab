# Hide English Example Sentence in Spelling Test

## Purpose
Prevent "answer leaking" during the vocabulary spelling test phase by hiding the English example sentence which often contains the target spelling word.

## Proposed Change
In `public/app.js`, within the `spellingCard(w)` function, we will remove the rendering of the `w.example_en` content.

Currently, the code renders:
```javascript
${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}</div>` : ""}
```

We will simply remove this line from the HTML template literal inside `spellingCard` to ensure only the Chinese meaning (and part of speech) is shown.

## Scope
This change only affects the `spellingCard` function. The `showWordIntro` function will continue to show the example sentence when introducing new words.

## Alternatives Considered
- Replacing the target word with blanks: Rejected by user preference.
- Showing the example after submission: Rejected by user preference.

## Implementation Plan
1. Edit `public/app.js`.
2. Locate `spellingCard(w)` function.
3. Remove the line rendering `<div class="ex">...</div>`.
