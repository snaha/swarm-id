---
paths:
  - "swarm-ui/**"
---

# Figma MCP Workflow

The Figma Desktop MCP server provides real-time design access. The Figma desktop app must be running with the design file open.

Use `get_design_context` with `clientLanguages: "html,css,typescript"` and `clientFrameworks: "svelte"`.

**Node IDs from URLs**: `https://figma.com/design/:fileKey/:fileName?node-id=1-2` -> nodeId = `"1:2"` (replace hyphen with colon).
