---
'@miinded/nestjs-raw-paginate': minor
---

Rename the package from `@miinded/nestjs-paginate` to `@miinded/nestjs-raw-paginate` and migrate the
repository to GitHub (`Miinded/nestjs-raw-paginate`). The new name better reflects the feature scope:
pagination, filtering and cursor support for raw TypeORM queries via `rawPaginate`.

Migration: replace `@miinded/nestjs-paginate` with `@miinded/nestjs-raw-paginate` in your dependencies.
The public API (`rawPaginate`, `RawPaginateConfig`) is unchanged.
