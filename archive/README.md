# Retired visual pipeline

`legacy-2026-09-13.tar.gz` preserves the old application immediately before retirement,
including uncommitted changes and untracked source files. Every archived regular file
was compared byte-for-byte with its working-tree source before removal (275 files).
The adjacent JSON manifest records the archive SHA-256, source commit, and included paths.
The archive also includes the pre-retirement package files, repo instructions, CI,
and test/helper directories; they are historical material, not active configuration.

To inspect it, extract into a separate directory, never over the active application:

```sh
mkdir /tmp/agent-plan-legacy
tar -xzf archive/legacy-2026-09-13.tar.gz -C /tmp/agent-plan-legacy
```

Git history remains intact. Runtime state, credentials, dependencies, and VCS metadata
were not bundled or removed. No task-state migration is performed.
