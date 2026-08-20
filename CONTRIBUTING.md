# Contributing

Contributions are welcome — bug reports, feature requests, documentation, and
pull requests. The plugin is source-available and free to use; see
[LICENSE](./LICENSE) for what that means.

## The contribution grant

By submitting a contribution, you agree to the contribution terms in section 3
("Contributions") of the [LICENSE](./LICENSE): you grant hviana an irrevocable,
worldwide, royalty-free licence to use, modify, publish, distribute, and
commercially exploit your contribution, including under a different licence.

That grant is what keeps the project honest: the source stays readable and the
software stays free to use, while the author can still license it commercially
where that matters. If your contribution is made in the course of your
employment, you confirm that your employer consents to it.

## Before you open a pull request

- The full gate is `pnpm run check` — typecheck, lint, test, build, and verify
  the published artifacts.
- Nothing in the suite reaches the internet, and no test needs a real Claude
  Code or Codex install. See the **Development** section of the README for the
  seams the tests inject, and the three suites that deliberately do not.
- A new runtime dependency changes the inlined bundles, so run
  `pnpm run notices` and commit the regenerated
  [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) with it.
