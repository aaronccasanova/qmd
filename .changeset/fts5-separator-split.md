---
"@tobilu/qmd": patch
---

Query terms are split on every separator the FTS5 tokenizer splits on, so `PIO-1384`, `cloud-init`, `src/lib/i18n.ts`, `@tobilu/qmd`, and `qmd://Vault/wiki` match whether bare or quoted, and `-"cloud-init"` actually excludes. The quoted path previously deleted separators instead of splitting on them, returning zero rows for terms the corpus plainly contains (#916). #939 (thanks @fxstein)
