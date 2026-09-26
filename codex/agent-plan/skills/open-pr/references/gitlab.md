# GitLab recipe

Use the repository's existing `glab` authentication and remote configuration.

1. Check access with `glab auth status` and inspect the branch and remotes with Git.
2. Look for an existing request before creating one:

   ```sh
   glab mr list --source-branch <source-branch> --target-branch <target-branch>
   ```

3. If pushing is authorized and required:

   ```sh
   git push -u <remote> HEAD:<source-branch>
   ```

4. If opening is authorized and no matching request exists:

   ```sh
   glab mr create --source-branch <source-branch> --target-branch <target-branch> --title <title> --description-file <body.md> --yes
   ```

Verify the returned MR head SHA when the host exposes it. Report mismatches; do not repair history, merge, or enable auto-merge.
