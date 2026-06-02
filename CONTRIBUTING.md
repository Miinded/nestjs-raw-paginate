# Contributing

Contributions are welcome! This guide will help you get up and running on the project.

## Prerequisites

| Tool    | Version                             |
| ------- | ----------------------------------- |
| Node.js | `>= 22`                             |
| pnpm    | `>= 10`                             |
| Docker  | for the local MariaDB test database |

> **Tip:** the exact pnpm version is pinned via `packageManager` in `package.json`. Corepack will pick it
> up automatically if enabled (`corepack enable`).

## Getting started

```bash
# 1. Clone the repository
git clone https://github.com/Miinded/nestjs-raw-paginate.git
cd nestjs-raw-paginate

# 2. Install dependencies
pnpm install

# 3. Start the local MariaDB used by the tests
make dev            # or: docker compose -f docker-compose.dev.yml up -d bdd

# 4. Run the test suite to verify everything works
pnpm test
```

The tests connect to MariaDB using the following environment variables (with sensible defaults, see
`docker-compose.dev.yml`):

| Variable        | Default       |
| --------------- | ------------- |
| `DB_HOST`       | `localhost`   |
| `MARIA_DB_PORT` | `3800`        |
| `DB_USERNAME`   | `rawpaginate` |
| `DB_PASSWORD`   | `rawpaginate` |
| `DB_DATABASE`   | `rawpaginate` |

## Available scripts

| Script              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `pnpm build`        | Compile TypeScript to `lib/`                            |
| `pnpm test`         | Run the Jest test suite                                 |
| `pnpm test:cov`     | Run tests with a coverage report                        |
| `pnpm lint`         | Lint the source with ESLint (type-checked)              |
| `pnpm format`       | Format all files with Prettier                          |
| `pnpm format:check` | Check formatting without writing                        |
| `pnpm deps:check`   | Enforce the dependency policy (framework deps as peers) |
| `pnpm ci:quality`   | Full local CI gate: deps + lint + format + test + build |

## Git hooks

[Husky](https://typicode.github.io/husky/) runs the following hooks automatically:

| Hook         | Action                                                         |
| ------------ | -------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — formats staged files with Prettier             |
| `commit-msg` | `commitlint` — validates Conventional Commits format           |
| `pre-push`   | `deps:check` + `lint` + `build` — prevents pushing broken code |

## Commit conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Common prefixes:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `test:` — adding or updating tests
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `chore:` — maintenance (deps, CI, tooling)

## Releasing

Versioning and publishing are handled by [Changesets](https://github.com/changesets/changesets).
When you make a user-facing change, add a changeset:

```bash
pnpm changeset
```

On merge to `main`, the Release workflow opens (or updates) a "release" pull request. Merging that PR
publishes the new version to npm.

## Pull request checklist

- [ ] Changes are scoped and focused on a single concern
- [ ] New or updated tests cover the changes
- [ ] `pnpm ci:quality` passes locally
- [ ] Commit messages follow Conventional Commits
- [ ] A [changeset](https://github.com/changesets/changesets) is added if the change affects the public API (`pnpm changeset`)
