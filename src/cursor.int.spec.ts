import { CollectionEntity } from './__tests__/collection.entity';
import { OrderState } from './__tests__/dto';
import { OrderEntity } from './__tests__/order.entity';
import { OrderRefundEntity } from './__tests__/orderRefund.entity';
import { PaginateQuery, PaginationType, Paginated } from 'nestjs-paginate';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { BaseDataSourceOptions } from 'typeorm/data-source/BaseDataSourceOptions.js';
import { rawPaginate, RawPaginateConfig } from './paginate';

type CursorDto = { orderId: string; nftCount: number };

const extractCursor = (link: string | undefined): string | undefined => {
  if (!link) return undefined;
  const match = /[?&]cursor=([^&]+)/.exec(link);
  return match ? decodeURIComponent(match[1]) : undefined;
};

describe('rawPaginate cursor', () => {
  let dataSource: DataSource;
  let collectionRepository: Repository<CollectionEntity>;
  let orderRepository: Repository<OrderEntity>;

  // Builds the raw query used by every test in this block.
  const buildQb = (): SelectQueryBuilder<CursorDto> =>
    dataSource
      .createQueryBuilder()
      .select('o.id', 'orderId')
      .addSelect('o.nftCount', 'nftCount')
      .from('order', 'o') as unknown as SelectQueryBuilder<CursorDto>;

  const config: RawPaginateConfig<CursorDto> = {
    sortableColumns: ['nftCount'],
    defaultSortBy: [['nftCount', 'DESC']],
    paginationType: PaginationType.CURSOR,
    defaultLimit: 2,
    maxLimit: 2,
    metadataColumns: {
      nftCount: 'number',
    },
  };

  beforeAll(async () => {
    const dbOptions: Omit<Partial<BaseDataSourceOptions>, 'poolSize'> = {
      dropSchema: true,
      synchronize: true,
      logging: ['error'],
      entities: [CollectionEntity, OrderEntity, OrderRefundEntity],
    };

    dataSource = new DataSource({
      ...dbOptions,
      type: 'mariadb',
      host: process.env.DB_HOST || 'localhost',
      port: +(process.env.MARIA_DB_PORT || 3800),
      username: process.env.DB_USERNAME || 'rawpaginate',
      password: process.env.DB_PASSWORD || 'rawpaginate',
      database: process.env.DB_DATABASE || 'rawpaginate',
    });
    await dataSource.initialize();

    collectionRepository = dataSource.getRepository(CollectionEntity);
    orderRepository = dataSource.getRepository(OrderEntity);

    const [collection] = await collectionRepository.save([
      collectionRepository.create({ id: 'collect-cursor', name: 'Cursor', fileSizeBytes: 1, sellingPrice: '1' }),
    ]);

    // Distinct nftCount values give a deterministic sort order for cursor traversal.
    await orderRepository.save(
      [5, 4, 3, 2, 1].map((nftCount) =>
        orderRepository.create({
          id: `order-cursor-${nftCount}`,
          collection,
          state: OrderState.COMPLETED,
          nftCount,
          amount: '1',
          sellingPrice: '1',
        }),
      ),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('exposes cursor metadata and links, and omits totalItems/page info', async () => {
    const query: PaginateQuery = { path: '' };

    const result = await rawPaginate<CursorDto>(query, buildQb(), config);

    expect(result).toBeInstanceOf(Paginated);
    expect(result.data.map((r) => r.nftCount)).toEqual([5, 4]);

    // Cursor mode does not expose offset-based metadata.
    expect(result.meta.totalItems).toBeUndefined();
    expect(result.meta.currentPage).toBeUndefined();
    expect(result.meta.totalPages).toBeUndefined();
    expect(result.meta.itemsPerPage).toBe(2);

    // The encoded `cursor` column must not leak into the returned rows.
    expect(result.data[0]).not.toHaveProperty('cursor');

    expect(result.links.current).toBeDefined();
    expect(result.links.next).toBeDefined();
  });

  it('traverses every page by following the `next` cursor', async () => {
    const collected: number[] = [];
    let cursor: string | undefined = undefined;

    for (let guard = 0; guard < 10; guard++) {
      const query: PaginateQuery = { path: '', cursor };
      const result: Paginated<CursorDto> = await rawPaginate<CursorDto>(query, buildQb(), config);

      collected.push(...result.data.map((r) => r.nftCount));

      const nextCursor = extractCursor(result.links.next);
      // `next` keeps being emitted while the page is full; stop once a page is not full.
      if (result.data.length < (config.maxLimit as number)) break;
      cursor = nextCursor;
    }

    expect(collected).toEqual([5, 4, 3, 2, 1]);
  });

  it('echoes the incoming cursor in meta.cursor', async () => {
    const firstPage = await rawPaginate<CursorDto>({ path: '' }, buildQb(), config);
    const nextCursor = extractCursor(firstPage.links.next);
    expect(nextCursor).toBeDefined();

    const secondPage = await rawPaginate<CursorDto>({ path: '', cursor: nextCursor }, buildQb(), config);

    expect(secondPage.meta.cursor).toBe(nextCursor);
    expect(secondPage.data.map((r) => r.nftCount)).toEqual([3, 2]);
  });
});
