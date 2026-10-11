---
"@tobilu/qmd": patch
---

A model file that fails to read (`EISDIR`, `EBUSY`, an I/O error, a truncated read) is no longer reported as invalid GGUF and deleted. Only a header that was actually read and found wrong removes the file. A transient read failure now surfaces the underlying error and leaves the multi-GB download in place. #917 (thanks @fxstein)
