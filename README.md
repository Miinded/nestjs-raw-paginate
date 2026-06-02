# @miinded/nestjs-raw-paginate

[![npm version](https://img.shields.io/npm/v/@miinded/nestjs-raw-paginate.svg)](https://www.npmjs.com/package/@miinded/nestjs-raw-paginate)
[![license](https://img.shields.io/npm/l/@miinded/nestjs-raw-paginate.svg)](./LICENSE)

Pagination, filtering and cursor support for **raw TypeORM queries** in a [NestJS](https://nestjs.com/)
application.

This package builds on top of [`nestjs-paginate`](https://github.com/ppetzold/nestjs-paginate) and adds
`rawPaginate`, which paginates an arbitrary `SelectQueryBuilder` by wrapping it in a subquery. This makes
pagination and filtering work even on complex aggregated / grouped / computed-column queries where the
standard entity-based `paginate` cannot be used.

It re-exports the full `nestjs-paginate` API, so you can use both from a single import.

## Features

- Paginate any `SelectQueryBuilder` (aggregations, `GROUP BY`, computed columns, …).
- Page-based (`limit`/`offset` or `take`/`skip`) **and cursor-based** pagination.
- Filtering, sorting and search compatible with the `nestjs-paginate` query format.
- `metadataColumns` mapping to drive column-type detection on raw selections.

## Installation

```bash
pnpm add @miinded/nestjs-raw-paginate
# or
npm install @miinded/nestjs-raw-paginate
```

Peer ecosystem: NestJS 11, TypeORM 0.3, Express 5.

## Usage

```ts
import { rawPaginate, RawPaginateConfig, PaginateQuery, Paginated } from '@miinded/nestjs-raw-paginate';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class OrderService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(query: PaginateQuery): Promise<Paginated<OrderRow>> {
    const qb = this.dataSource
      .createQueryBuilder()
      .select('o.id', 'id')
      .addSelect('o.customer_id', 'customerId')
      .addSelect('SUM(oi.amount)', 'total')
      .from('orders', 'o')
      .leftJoin('order_items', 'oi', 'oi.order_id = o.id')
      .groupBy('o.id');

    const config: RawPaginateConfig<OrderRow> = {
      sortableColumns: ['id', 'total'],
      defaultSortBy: [['id', 'DESC']],
      filterableColumns: {
        total: true,
        customerId: true,
      },
      // Map raw selection aliases to their column type for cursor/filter handling.
      metadataColumns: {
        id: 'varchar',
        total: 'decimal',
      },
    };

    return rawPaginate(query, qb, config);
  }
}
```

`rawPaginate(query, qb, config)` returns a standard `Paginated<T>` payload (data + `meta` + `links`),
identical to `nestjs-paginate`.

### Cursor pagination

Set `paginationType` to cursor mode in the config; cursors are encoded faithfully to the
`nestjs-paginate` implementation, with column-type detection driven by `metadataColumns`.

## API

| Export                   | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `rawPaginate`            | Paginate/filter/sort a raw `SelectQueryBuilder`.                 |
| `RawPaginateConfig<T>`   | Config type (a `PaginateConfig` variant with `metadataColumns`). |
| `* from nestjs-paginate` | The full upstream API is re-exported.                            |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Tests run against a local MariaDB started with
`make dev` (or `docker compose -f docker-compose.dev.yml up -d bdd`).

## License

[MIT](./LICENSE) © Miinded
