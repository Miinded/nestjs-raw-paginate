import { CollectionEntity } from './__tests__/collection.entity';
import { OrderRefundState, OrderState, QueryDto } from './__tests__/dto';
import { OrderEntity } from './__tests__/order.entity';
import { OrderRefundEntity } from './__tests__/orderRefund.entity';
import { FilterOperator, FilterSuffix, PaginateConfig, Paginated, PaginateQuery } from 'nestjs-paginate';
import { DataSource, Repository } from 'typeorm';
import { BaseDataSourceOptions } from 'typeorm/data-source/BaseDataSourceOptions.js';
import { rawPaginate } from './paginate';

describe('paginate', () => {
  let dataSource: DataSource;
  let collectionRepository: Repository<CollectionEntity>;
  let orderRepository: Repository<OrderEntity>;
  let orderRefunRepository: Repository<OrderRefundEntity>;

  let collections: CollectionEntity[];
  let orders: OrderEntity[];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let ordersRefunds: OrderRefundEntity[];

  beforeAll(async () => {
    const dbOptions: Omit<Partial<BaseDataSourceOptions>, 'poolSize'> = {
      dropSchema: true,
      synchronize: true,
      logging: ['error'],
      entities: [
        //
        CollectionEntity,
        OrderEntity,
        OrderRefundEntity,
      ],
    };

    dataSource = new DataSource({
      ...dbOptions,
      type: 'mariadb',
      host: process.env.DB_HOST || 'localhost',
      port: +process.env.MARIA_DB_PORT || 3800,
      username: process.env.DB_USERNAME || 'rawpaginate',
      password: process.env.DB_PASSWORD || 'rawpaginate',
      database: process.env.DB_DATABASE || 'rawpaginate',
    });
    await dataSource.initialize();
    //
    collectionRepository = dataSource.getRepository(CollectionEntity);
    orderRepository = dataSource.getRepository(OrderEntity);
    orderRefunRepository = dataSource.getRepository(OrderRefundEntity);

    collections = await collectionRepository.save([
      //
      collectionRepository.create({
        id: 'collect-1',
        name: 'Ailus',
        fileSizeBytes: 12097,
        sellingPrice: '4200000000000000',
      }),
    ]);
    //
    orders = await orderRepository.save([
      //
      orderRepository.create({
        id: 'order-1',
        collection: collections[0],
        state: OrderState.COMPLETED,
        nftCount: 1,
        amount: '671800',
        sellingPrice: '420000',
      }),

      orderRepository.create({
        id: 'order-2',
        collection: collections[0],
        state: OrderState.REFUND_SOLDOUT,
        nftCount: 1,
        amount: '671800',
        sellingPrice: '420000',
      }),

      orderRepository.create({
        id: 'order-3',
        collection: collections[0],
        state: OrderState.EXPIRED,
        nftCount: 2,
        amount: '1318600',
        sellingPrice: '840000',
      }),
    ]);

    ordersRefunds = await orderRefunRepository.save([
      //
      orderRefunRepository.create({
        id: 'refund-order2-1',
        refundAmount: '671800',
        state: OrderRefundState.COMPLETED,
        order: orders[1],
      }),
    ]);
  });

  xit('should return an instance of Paginated width default limit', async () => {
    const config: PaginateConfig<QueryDto> = {
      sortableColumns: ['orderId'],
      defaultSortBy: [['orderId', 'DESC']],
    };
    const query: PaginateQuery = {
      path: '',
    };

    let qb = dataSource.createQueryBuilder();
    qb = qb
      .select('o.id', 'orderId')
      .addSelect('orf.state', 'refundState')
      .addSelect('orf.refundAmount', 'refundAmount')
      .addSelect('SUM(IF(orf.state = :completedState, 1, 0))', 'refundCompleted')
      .addSelect('SUM(IF(orf.state = :validateState, 1, 0))', 'refundValidate')
      .addSelect('SUM(IF(orf.state = :sendingState, 1, 0))', 'refundSending')
      .setParameters({
        completedState: 'COMPLETED',
        validateState: 'VALIDATE',
        sendingState: 'SENDING',
      })
      .from('order', 'o')
      .leftJoin('order_refund', 'orf', 'orf.orderId = o.id')
      .groupBy('o.id');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const results = await rawPaginate<QueryDto>(query, qb, config);

    expect(results).toBeInstanceOf(Paginated);
    expect(results.data).toHaveLength(3);
    expect(results.data[0].orderId).toEqual('order-3');
    expect(results.data).toContainEqual(expect.objectContaining({ orderId: 'order-3' }));
    expect(results.data[0]).toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      orderId: expect.any(String),
    });
  });

  it('should return an instance of Paginated width custom limit', async () => {
    const config: PaginateConfig<QueryDto> = {
      sortableColumns: ['orderId'],
      defaultSortBy: [['orderId', 'DESC']],
      defaultLimit: 1,
    };
    const query: PaginateQuery = {
      path: '',
    };

    let qb = dataSource.createQueryBuilder();
    qb = qb
      .select('o.id', 'orderId')
      .addSelect('orf.state', 'refundState')
      .addSelect('orf.refundAmount', 'refundAmount')
      .addSelect('SUM(IF(orf.state = :completedState, 1, 0))', 'refundCompleted')
      .addSelect('SUM(IF(orf.state = :validateState, 1, 0))', 'refundValidate')
      .addSelect('SUM(IF(orf.state = :sendingState, 1, 0))', 'refundSending')
      .setParameters({
        completedState: 'COMPLETED',
        validateState: 'VALIDATE',
        sendingState: 'SENDING',
      })
      .from('order', 'o')
      .leftJoin('order_refund', 'orf', 'orf.orderId = o.id')
      .groupBy('o.id');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const results = await rawPaginate<QueryDto>(query, qb, config);

    expect(results).toBeInstanceOf(Paginated);
    expect(results.data).toHaveLength(1);
    expect(results.meta.totalPages).toEqual(3);
    expect(results.meta.totalItems).toEqual(3);
    expect(results.data[0].orderId).toEqual('order-3');
    expect(results.data).toContainEqual(expect.objectContaining({ orderId: 'order-3' }));
    expect(results.data[0]).toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      orderId: expect.any(String),
    });
  });

  xit('should return an instance of Paginated', async () => {
    const config: PaginateConfig<QueryDto> = {
      sortableColumns: ['orderId'],
      defaultSortBy: [['orderId', 'DESC']],
      filterableColumns: {
        refundState: [FilterOperator.NULL, FilterSuffix.NOT],
      },
      // defaultLimit: 1,
    };
    const query: PaginateQuery = {
      sortBy: [['orderId', 'ASC']],
      filter: {
        refundState: '$not:$null',
      },
      path: '',
    };

    let qb = dataSource.createQueryBuilder();
    qb = qb
      .select('o.id', 'orderId')
      .addSelect('orf.state', 'refundState')
      .addSelect('orf.refundAmount', 'refundAmount')
      .addSelect('SUM(IF(orf.state = :completedState, 1, 0))', 'refundCompleted')
      .addSelect('SUM(IF(orf.state = :validateState, 1, 0))', 'refundValidate')
      .addSelect('SUM(IF(orf.state = :sendingState, 1, 0))', 'refundSending')
      .setParameters({
        completedState: 'COMPLETED',
        validateState: 'VALIDATE',
        sendingState: 'SENDING',
      })
      .from('order', 'o')
      .leftJoin('order_refund', 'orf', 'orf.orderId = o.id')
      .groupBy('o.id');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const results = await rawPaginate<QueryDto>(query, qb, config);

    expect(results).toBeInstanceOf(Paginated);
    expect(results.data).toHaveLength(1);
    expect(results.data[0].orderId).toEqual('order-2');
  });

  afterAll(async () => {
    await dataSource.destroy();
  });
});
