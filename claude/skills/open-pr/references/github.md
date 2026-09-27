# GitHub recipe

Use the repository's existing `gh` authentication and remote configuration.

1. Check access with `gh auth status` and inspect the branch and remotes with Git.
2. Look for an existing request before creating one:

   ```sh
   gh pr list --state open --head <source-branch> --base <target-branch> --json number,url,headRefOid
   ```

3. If pushing is authorized and required:

   ```sh
   git push -u <remote> HEAD:<source-branch>
   ```

4. If opening is authorized and no matching request exists:

   ```sh
   gh pr create --base <target-branch> --head <source-branch> --title <title> --body-file <body.md>
   ```

Verify the returned PR head SHA when the host exposes it. Report mismatches; do not repair history, merge, or enable auto-merge.
