# Changesets

Add a changeset to every pull request that changes what ships in `@tobilu/qmd`:

```sh
bun run changeset
```

Choose the SemVer bump and write a user-facing summary. The summary becomes the
`CHANGELOG.md` entry, so follow the same standard as before:

- Explain the why, not only the what. The changelog is for users.
- Include numbers where they exist ("2.7x faster", "17x less memory").
- Credit external contributors by ending the summary with `#NNN (thanks @username)`.

Changes to tests, CI, or internal tooling don't need a changeset.

Merging to `main` creates or updates a "Version Packages" PR that bumps the
version and writes the changelog. Merging that PR publishes to npm, pushes the
`vX.Y.Z` tag, and creates the GitHub release. See the
[Changesets docs](https://github.com/changesets/changesets) for details.
