# Release checklist

Use this checklist for public releases.

- [ ] Start from the last user-validated runtime, not from an unverified refactor branch.
- [ ] Keep product changes and code-quality changes in separate commits/PRs when practical.
- [ ] Run `npm run verify` from the repository root.
- [ ] Confirm Day renders time labels, blocks, tasks/outcomes, and Notes.
- [ ] Confirm Week renders all configured planning days and existing blocks.
- [ ] Confirm Week drag, cross-day move, and bottom resize for any release touching schedule interaction.
- [ ] Confirm Search opens, returns results, and closes.
- [ ] Confirm Journal, Unresolved, Horizon, Time stats, Settings, and How it works open and close.
- [ ] Confirm Add/Edit block works.
- [ ] Confirm Fit app to width toggles both ways.
- [ ] Confirm mobile header actions and Week sticky hour gutter for any responsive change.
- [ ] Confirm onboarding pages when onboarding code or shared modal CSS changes.
- [ ] Bump the service-worker cache only when shipping changed runtime assets.
- [ ] Confirm `runtime-config.js` contains no owner-specific links in the public source.
- [ ] Confirm the public source contains no unrelated project/organization names.
- [ ] Do not commit `dist/`; generate it for deployment with `npm run build`.
