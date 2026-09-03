# Review fixes — round 10

- Restored acceptance of the established CLI `focused correction` shorthand only when it targets exactly one approved file.
- Classified bare delete/pronoun steering as ambiguous, so it is withheld at the needs-input checkpoint rather than treated as a new requirement.
- Added validator coverage for the bounded shorthand.

Verification was not run: the only configured project command is the canonical `verify` command, which this step explicitly prohibits workers from running.
