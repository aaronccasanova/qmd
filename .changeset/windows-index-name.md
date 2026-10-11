---
"@tobilu/qmd": patch
---

Windows absolute paths (`D:\data\project`, UNC shares) are sanitized when deriving index and config filenames. The drive-letter colon and backslashes were previously written straight into the filename. #928 (thanks @yotamleo)
