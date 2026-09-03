# Review fixes — round 13

Preview cleanup settlement now invokes a run-bound durable observer after deriving its public cleanup status. The daemon stores that result on the preview record for the owning active or retained run, so late `incomplete` and `unsupported` outcomes remain actionable rather than being relabeled `stopped` by bounded lifecycle cleanup.

Regression coverage verifies that a cleanup which settles after the bounded wait reports `cleanup_unsupported` to the settlement observer.
