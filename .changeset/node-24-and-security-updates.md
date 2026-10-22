---
'@miinded/nestjs-raw-paginate': minor
---

Require Node.js >= 24 and refresh dependencies for security fixes.

- `engines.node` is now `>=24` (Node.js 22 is no longer supported).
- `nestjs-paginate` raised to `^13.5.1` and `lodash` to `^4.18.1` (fixes lodash advisories).
- Compatibility with `nestjs-paginate` >= 13.4: polymorphic sort groups (`colA~colB`) from the query are ignored, and a polymorphic `defaultSortBy` now throws an explicit error, since raw subqueries cannot express them.
