---
"@tobilu/qmd": patch
---

The REST `POST /query` and `/search` endpoints return `400 {"error": "Invalid JSON body"}` for a malformed request body instead of an opaque `500` and a stack trace in the daemon log, matching the existing guard on `/mcp`. #929 (thanks @yotamleo)
