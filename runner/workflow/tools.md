# Action reference

Tools: runner_write({area:"artifacts",path,content}) creates immutable artifacts.
runner_action actions and input:
- inspect: {} — task state and file references
- spawn: {assignment,mode:"write"|"explore",stage,modelChoice?,model?,provider?,modelReason?,contract?,reviewRole?}
- pause: {workerId,artifact} — pause a worker with a recorded question; answer to resume
- contract: {artifact} — publish a shared contract; revisions require no active writers
- clarify: {artifact,risks?:["security"|"data-safety"|"database"|"recovery"|"operator"|"ui"|"performance"]} — record coordinator review of the current document revisions
- surface: {artifact,attachments?} — notify the owner without creating a blocking question
- ask: {artifact,attachments?,requiresOwner?,hook?} — ask a blocking question, then stop until an answer arrives. For coordinators, a supervisor may answer routine questions from agreed requirements. Set requiresOwner:true for new scope/product choices or other decisions needing the human; approval hooks always require the human.
- answer: {decisionId,artifact} — answer a worker question
- integrate: {workerId} — commit references come from worker reports
- verify: {} — execute snapshotted repo commands and retain output files
- report: {status:"completed"|"failed",artifact}
- remove: {path} — workers only; delete a file in their worktree
- command: {name} — run a named command in your worktree, retaining output


Review spawns use mode="explore", stage="review" and one persisted required
reviewRole: requirements, correctness, security, database, ui, performance or recovery.
Verify first; parallel reviewers share the exact frozen candidate within maxWorkers.
Each completed role report supplies matching commit/reviewRole and nonempty coverage.
