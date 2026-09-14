# Action reference

Tools: runner_write({area:"artifacts",path,content}) creates immutable artifacts.
runner_action actions and input:
- inspect: {} — task state and file references
- spawn: {assignment,mode:"write"|"explore",stage,modelChoice?,model?,provider?,modelReason?,contract?}
- pause: {workerId,artifact} — pause a worker with a recorded question; answer to resume
- contract: {artifact} — publish a shared contract; revisions require no active writers
- clarify: {artifact} — record coordinator review of the current document revisions
- surface: {artifact,attachments?} — notify the owner without creating a blocking question
- ask: {artifact,attachments?} — ask the user, then stop until an answer arrives
- answer: {decisionId,artifact} — answer a worker question
- integrate: {workerId} — commit references come from worker reports
- verify: {} — execute snapshotted repo commands and retain output files
- report: {status:"completed"|"failed",artifact}
- remove: {path} — workers only; delete a file in their worktree
- command: {name} — run a named command in your worktree, retaining output

