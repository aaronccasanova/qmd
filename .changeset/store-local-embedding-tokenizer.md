---
"@tobilu/qmd": patch
---

Embedding generation and legacy fingerprint adoption now tokenize documents with the store-selected embedding model instead of the global default. This keeps chunk boundaries aligned with the model that creates and verifies the stored vectors without initializing an unrelated provider.
