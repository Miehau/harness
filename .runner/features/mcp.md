# Supervisor MCP

OMP discovers MCP servers from `~/.omp/agent/mcp.json` and `.omp/mcp.json`.
The runner uses that native support; the obsolete Pi adapter is not loaded.
`--mcp` is a compatibility flag; `--mcp-config` reports migration instructions.
Credentials stay in the local MCP configuration, outside task snapshots.

See `runner/docs/supervisor.md`. Tests cover launcher arguments and actual pinned
OMP extension loading; production MCP endpoints require their own live checks.
