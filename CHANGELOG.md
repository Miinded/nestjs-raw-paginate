# @miinded/nestjs-raw-paginate

## 0.2.0

### Minor Changes

- 0e2ad6f: Require Node.js >= 24 and refresh dependencies for security fixes.

  - `engines.node` is now `>=24` (Node.js 22 is no longer supported).
  - `nestjs-paginate` raised to `^13.5.1` and `lodash` to `^4.18.1` (fixes lodash advisories).
  - Compatibility with `nestjs-paginate` >= 13.4: polymorphic sort groups (`colA~colB`) from the query are ignored, and a polymorphic `defaultSortBy` now throws an explicit error, since raw subqueries cannot express them.

## 0.1.0

### Minor Changes

- b8adbfe: Rename the package from `@miinded/nestjs-paginate` to `@miinded/nestjs-raw-paginate` and migrate the
  repository to GitHub (`Miinded/nestjs-raw-paginate`). The new name better reflects the feature scope:
  pagination, filtering and cursor support for raw TypeORM queries via `rawPaginate`.

  Migration: replace `@miinded/nestjs-paginate` with `@miinded/nestjs-raw-paginate` in your dependencies.
  The public API (`rawPaginate`, `RawPaginateConfig`) is unchanged.
