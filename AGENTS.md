# skilladopt: rules for coding agents

skilladopt is an open-source Node.js CLI (npm package `skilladopt`) that fits third-party agent skills to a codebase and records the evidence for every decision.

- Keep the code small. Remove dead code before adding features; add a feature only when a real case needs it.
- No runtime dependencies. Every safety or correctness fix comes with a regression test (`npm test`).
- Releases: bump the version in `package.json` and `src/util.ts`, then push a `vX.Y.Z` tag; GitHub Actions publishes to npm.
- Claims in README, posts and replies must match what the code does and what was measured. Say what is not verified yet.
- Promotion order: a few outside testers first, then Show GN (GeekNews), then Show HN. One honest post per channel.
- Never promote skilladopt in other projects' issues, pull requests or discussions.
