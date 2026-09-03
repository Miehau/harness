# Review fixes — round 16

- Chromium screenshots now run through the non-signaling managed command runner. Capture deadlines and aborts request token-validated containment cleanup instead of allowing a child-PID timeout signal.
- Repository-check completion now carries its timestamped cleanup trigger from `PiHarness` into daemon settlement, so the durable cleanup record deduplicates the one lifecycle event.

Regression coverage verifies a timed-out Chromium capture is allowed to exit normally while containment receives the cleanup request, and verifies daemon settlement retains one timestamped repository-check exit trigger.
