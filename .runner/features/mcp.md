# Supervisor MCP

`supervisorArgs` in `runner/cli.js` translates `--mcp` or `--mcp-config FILE` into
Pi's native extension loader with pinned `pi-mcp-adapter@2.33.0`. Other Pi arguments
are preserved. The external adapter owns protocol, discovery and authentication;
there is no runner MCP client or server-credential snapshot. Native adapter config
merging applies. Managed agents remain on the runner-only extension/tool set.

Evidence: `test/supervisor.test.js` checks opt-in loading, version pinning, forwarded
configuration/model arguments and missing config values without a live model.

A disposable SDK smoke check also loaded the published 2.33.0 adapter in installed
Pi 0.84.0, listed a mock stdio ticket server's tool and called it successfully.
That check used isolated Pi state and no model or real ticket account. It does not
establish compatibility with a particular production ticket server.
