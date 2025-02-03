/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { ServiceUnavailableException } from '@nestjs/common';
import { PaginateConfig as OPaginateConfig, Paginated, PaginateQuery, PaginationLimit, PaginationType } from 'nestjs-paginate';
import { Column, positiveNumberOrDefault, SortBy, isEntityKey, Order, getPropertiesByColumnName, checkIsRelation, checkIsEmbedded, fixColumnAlias, includesAllPrimaryKeyColumns, getQueryUrlComponents, isISODate, ColumnProperties } from 'nestjs-paginate/lib/helper';
import { FilterComparator, FilterOperator, FilterSuffix, fixQueryParam, generatePredicateCondition, isOperator, isSuffix, OperatorSymbolToFunction, parseFilter, parseFilterToken } from 'nestjs-paginate/lib/filter';
import { Brackets, FindOperator, JsonContains, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { mapKeys } from 'lodash';
import { stringify } from 'querystring';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { WherePredicateOperator } from 'typeorm/query-builder/WhereClause';

export type RawPaginateConfig<T> = Omit<OPaginateConfig<T>, 'where' | 'relations' | 'loadEagerRelations'> & {
  metadataColumns?: {
    [key: string]: string;
  };
};

export async function rawPaginate<T extends ObjectLiteral>(query: PaginateQuery, qb: SelectQueryBuilder<T>, config: RawPaginateConfig<T>): Promise<Paginated<T>> {
  const page = positiveNumberOrDefault(query.page, 1, 1);

  const defaultLimit = config.defaultLimit || PaginationLimit.DEFAULT_LIMIT;
  const maxLimit = config.maxLimit || PaginationLimit.DEFAULT_MAX_LIMIT;
  const isPaginated = !(query.limit === PaginationLimit.COUNTER_ONLY || (query.limit === PaginationLimit.NO_PAGINATION && maxLimit === PaginationLimit.NO_PAGINATION));

  const limit = query.limit === PaginationLimit.COUNTER_ONLY ? PaginationLimit.COUNTER_ONLY : isPaginated === true ? (maxLimit === PaginationLimit.NO_PAGINATION ? (query.limit ?? defaultLimit) : query.limit === PaginationLimit.NO_PAGINATION ? defaultLimit : Math.min(query.limit ?? defaultLimit, maxLimit)) : defaultLimit;

  const sortBy = [] as SortBy<T>;
  const searchBy: Column<T>[] = [];

  let [items, totalItems]: [T[], number] = [[], 0];

  const queryBuilder = qb
    .createQueryBuilder()
    //
    .select('*')
    .from(`(${qb.getQuery()})`, 'subquery')
    .setParameters(qb.getParameters());

  if (isPaginated) {
    // Allow user to choose between limit/offset and take/skip.
    // However, using limit/offset can cause problems when joining one-to-many etc.
    if (config.paginationType === PaginationType.LIMIT_AND_OFFSET) {
      queryBuilder.limit(limit).offset((page - 1) * limit);
    } else {
      queryBuilder.take(limit).skip((page - 1) * limit);
    }
  }

  const dbType = qb.connection.options.type;
  const isMariaDbOrMySql = (dbType: string) => dbType === 'mariadb' || dbType === 'mysql';

  const isMMDb = isMariaDbOrMySql(dbType);

  let nullSort: string | undefined;
  if (config.nullSort) {
    if (isMMDb) {
      nullSort = config.nullSort === 'last' ? 'IS NULL' : 'IS NOT NULL';
    } else {
      nullSort = config.nullSort === 'last' ? 'NULLS LAST' : 'NULLS FIRST';
    }
  }

  if (config.sortableColumns.length < 1) {
    const message = "Missing required 'sortableColumns' config.";
    throw new ServiceUnavailableException(message);
  }

  if (query.sortBy) {
    for (const order of query.sortBy) {
      if (isEntityKey(config.sortableColumns, order[0]) && ['ASC', 'DESC'].includes(order[1])) {
        sortBy.push(order as Order<T>);
      }
    }
  }

  if (!sortBy.length) {
    sortBy.push(...(config.defaultSortBy || [[config.sortableColumns[0], 'ASC']]));
  }

  for (const order of sortBy) {
    const columnProperties = getPropertiesByColumnName(order[0]);
    const { isVirtualProperty } = extractVirtualProperty(queryBuilder, columnProperties);

    const isRelation = checkIsRelation(queryBuilder, columnProperties.propertyPath);
    const isEmbeded = checkIsEmbedded(queryBuilder, columnProperties.propertyPath);
    let alias = fixColumnAlias(columnProperties, queryBuilder.alias, isRelation, isVirtualProperty, isEmbeded);

    if (isMMDb) {
      if (isVirtualProperty) {
        alias = `\`${alias}\``;
      }
      if (nullSort) {
        queryBuilder.addOrderBy(`${alias} ${nullSort}`);
      }
      queryBuilder.addOrderBy(alias, order[1]);
    } else {
      if (isVirtualProperty) {
        alias = `"${alias}"`;
      }
      queryBuilder.addOrderBy(alias, order[1], nullSort as 'NULLS FIRST' | 'NULLS LAST' | undefined);
    }
  }

  // When we partial select the columns (main or relation) we must add the primary key column otherwise
  // typeorm will not be able to map the result.
  let selectParams = config.select && query.select && !config.ignoreSelectInQueryParam ? config.select.filter((column) => query.select.includes(column)) : config.select;
  if (!includesAllPrimaryKeyColumns(queryBuilder, query.select)) {
    selectParams = config.select;
  }
  if (selectParams?.length > 0 && includesAllPrimaryKeyColumns(queryBuilder, selectParams)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const cols: string[] = selectParams.reduce((cols, currentCol) => {
      const columnProperties = getPropertiesByColumnName(currentCol);
      const isRelation = checkIsRelation(queryBuilder, columnProperties.propertyPath);
      cols.push(fixColumnAlias(columnProperties, queryBuilder.alias, isRelation));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return cols;
    }, []);
    queryBuilder.select(cols);
  }

  if (config.withDeleted) {
    queryBuilder.withDeleted();
  }

  if (config.searchableColumns) {
    if (query.searchBy && !config.ignoreSearchByInQueryParam) {
      for (const column of query.searchBy) {
        if (isEntityKey(config.searchableColumns, column)) {
          searchBy.push(column);
        }
      }
    } else {
      searchBy.push(...config.searchableColumns);
    }
  }

  if (query.search && searchBy.length) {
    queryBuilder.andWhere(
      new Brackets((qb: SelectQueryBuilder<T>) => {
        // Explicitly handle the default case - multiWordSearch defaults to false
        const useMultiWordSearch = config.multiWordSearch ?? false;
        if (!useMultiWordSearch) {
          // Strict search mode (default behavior)
          for (const column of searchBy) {
            const property = getPropertiesByColumnName(column);
            const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(qb, property);
            const isRelation = checkIsRelation(qb, property.propertyPath);
            const isEmbedded = checkIsEmbedded(qb, property.propertyPath);
            const alias = fixColumnAlias(property, qb.alias, isRelation, isVirtualProperty, isEmbedded, virtualQuery);

            const condition: WherePredicateOperator = {
              operator: 'ilike',
              parameters: [alias, `:${property.column}`],
            };

            if (['postgres', 'cockroachdb'].includes(queryBuilder.connection.options.type)) {
              condition.parameters[0] = `CAST(${condition.parameters[0]} AS text)`;
            }

            qb.orWhere(qb['createWhereConditionExpression'](condition), {
              [property.column]: `%${query.search}%`,
            });
          }
        } else {
          // Multi-word search mode
          const searchWords = query.search.split(' ').filter((word) => word.length > 0);
          searchWords.forEach((searchWord, index) => {
            qb.andWhere(
              new Brackets((subQb: SelectQueryBuilder<T>) => {
                for (const column of searchBy) {
                  const property = getPropertiesByColumnName(column);
                  const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(subQb, property);
                  const isRelation = checkIsRelation(subQb, property.propertyPath);
                  const isEmbedded = checkIsEmbedded(subQb, property.propertyPath);
                  const alias = fixColumnAlias(property, subQb.alias, isRelation, isVirtualProperty, isEmbedded, virtualQuery);

                  const condition: WherePredicateOperator = {
                    operator: 'ilike',
                    parameters: [alias, `:${property.column}_${index}`],
                  };

                  if (['postgres', 'cockroachdb'].includes(queryBuilder.connection.options.type)) {
                    condition.parameters[0] = `CAST(${condition.parameters[0]} AS text)`;
                  }

                  subQb.orWhere(subQb['createWhereConditionExpression'](condition), {
                    [`${property.column}_${index}`]: `%${searchWord}%`,
                  });
                }
              }),
            );
          });
        }
      }),
    );
  }

  if (query.filter) {
    addFilter(queryBuilder, query, config.filterableColumns, config.metadataColumns);
  }

  if (query.limit === PaginationLimit.COUNTER_ONLY) {
    totalItems = await getCount(queryBuilder);
  } else if (isPaginated) {
    items = await queryBuilder.getRawMany<T>(); //
    totalItems = await getCount(queryBuilder);
  } else {
    items = await queryBuilder.getRawMany<T>();
  }
  const sortByQuery = sortBy.map((order) => `&sortBy=${order.join(':')}`).join('');
  const searchQuery = query.search ? `&search=${query.search}` : '';

  const searchByQuery = query.searchBy && searchBy.length && !config.ignoreSearchByInQueryParam ? searchBy.map((column) => `&searchBy=${column}`).join('') : '';

  // Only expose select in meta data if query select differs from config select
  const isQuerySelected = selectParams?.length !== config.select?.length;
  const selectQuery = isQuerySelected ? `&select=${selectParams.join(',')}` : '';

  const filterQuery = query.filter
    ? '&' +
      stringify(
        mapKeys(query.filter, (_param, name) => 'filter.' + name),
        '&',
        '=',
        { encodeURIComponent: (str) => str },
      )
    : '';

  const options = `&limit=${limit}${sortByQuery}${searchQuery}${searchByQuery}${selectQuery}${filterQuery}`;

  let path: string = null;
  if (query.path !== null) {
    // `query.path` does not exist in RPC/WS requests and is set to null then.
    const { queryOrigin, queryPath } = getQueryUrlComponents(query.path);
    if (config.relativePath) {
      path = queryPath;
    } else if (config.origin) {
      path = config.origin + queryPath;
    } else {
      path = queryOrigin + queryPath;
    }
  }
  const buildLink = (p: number): string => path + '?page=' + p + options;

  const totalPages = isPaginated ? Math.ceil(totalItems / limit) : 1;

  const results: Paginated<T> = {
    data: items,
    meta: {
      itemsPerPage: limit === PaginationLimit.COUNTER_ONLY ? totalItems : isPaginated ? limit : items.length,
      totalItems: limit === PaginationLimit.COUNTER_ONLY || isPaginated ? totalItems : items.length,
      currentPage: page,
      totalPages,
      sortBy,
      search: query.search,
      searchBy: query.search ? searchBy : undefined,
      select: isQuerySelected ? selectParams : undefined,
      filter: query.filter,
    },
    // If there is no `path`, don't build links.
    links:
      path !== null
        ? {
            first: page == 1 ? undefined : buildLink(1),
            previous: page - 1 < 1 ? undefined : buildLink(page - 1),
            current: buildLink(page),
            next: page + 1 > totalPages ? undefined : buildLink(page + 1),
            last: page == totalPages || !totalItems ? undefined : buildLink(totalPages),
          }
        : ({} as Paginated<T>['links']),
  };

  return Object.assign(new Paginated<T>(), results);
}

export async function getCount(qb: SelectQueryBuilder<ObjectLiteral>) {
  const countSql = 'COUNT(1)';
  const result = await qb
    .clone()
    //
    .orderBy()
    .groupBy()
    .offset(undefined)
    .limit(undefined)
    .skip(undefined)
    .take(undefined)
    .select(countSql, 'cnt')
    .setOption('disable-global-order')
    .getRawOne<{ cnt: string }>();

  if (!result || !result.cnt) return 0;
  return Number.parseInt(result.cnt);
}

type Filter = { comparator: FilterComparator; findOperator: FindOperator<string> };
type ColumnsFilters = { [columnName: string]: Filter[] };

export function parseFilterForRawQuery<T>(query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }, qb?: SelectQueryBuilder<T>, metadataColumns?: { [column: string]: string }): ColumnsFilters {
  const filter: ColumnsFilters = {};
  if (!filterableColumns || !query.filter) {
    return {};
  }
  for (const column of Object.keys(query.filter)) {
    if (!(column in filterableColumns)) {
      continue;
    }
    const allowedOperators = filterableColumns[column];
    const input = query.filter[column];
    const statements = !Array.isArray(input) ? [input] : input;
    for (const raw of statements) {
      const token = parseFilterToken(raw);
      if (!token) {
        continue;
      }
      if (allowedOperators === true) {
        if (token.operator && !isOperator(token.operator)) {
          continue;
        }
        if (token.suffix && !isSuffix(token.suffix)) {
          continue;
        }
      } else {
        if (token.operator && token.operator !== FilterOperator.EQ && !allowedOperators.includes(token.operator)) {
          continue;
        }
        if (token.suffix && !allowedOperators.includes(token.suffix)) {
          continue;
        }
      }

      const params: (typeof filter)[0][0] = {
        comparator: token.comparator,
        findOperator: undefined,
      };
      const fixValue = fixRawColumnFilterValue(column, qb, metadataColumns);

      const columnProperties = getPropertiesByColumnName(column);
      const isJsonb = checkIsJsonb(qb, columnProperties.column);

      switch (token.operator) {
        case FilterOperator.BTW:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)(...token.value.split(',').map(fixValue));
          break;
        case FilterOperator.IN:
        case FilterOperator.CONTAINS:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)(token.value.split(','));
          break;
        case FilterOperator.ILIKE:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)(`%${token.value}%`);
          break;
        case FilterOperator.SW:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)(`${token.value}%`);
          break;
        default:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)(fixValue(token.value));
      }

      if (isJsonb) {
        const parts = column.split('.');
        const dbColumnName = parts[parts.length - 2];
        const jsonColumnName = parts[parts.length - 1];

        const jsonFixValue = fixRawColumnFilterValue(column, qb, metadataColumns, true);

        const jsonParams = {
          comparator: params.comparator,
          findOperator: JsonContains({
            [jsonColumnName]: jsonFixValue(token.value),
            //! Below seems to not be possible from my understanding, https://github.com/typeorm/typeorm/pull/9665
            //! This limits the functionaltiy to $eq only for json columns, which is a bit of a shame.
            //! If this is fixed or changed, we can use the commented line below instead.
            //[jsonColumnName]: params.findOperator,
          }),
        };

        filter[dbColumnName] = [...(filter[column] || []), jsonParams];
      } else {
        filter[column] = [...(filter[column] || []), params];
      }

      if (token.suffix) {
        const lastFilterElement = filter[column].length - 1;
        filter[column][lastFilterElement].findOperator = OperatorSymbolToFunction.get(token.suffix)(filter[column][lastFilterElement].findOperator);
      }
    }
  }
  return filter;
}

export function formatFilter<T>(qb: SelectQueryBuilder<T>, query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }, metadataColumns?: { [column: string]: string }) {
  if (qb?.expressionMap?.mainAlias?.hasMetadata) {
    return parseFilter(query, filterableColumns, qb);
  }
  return parseFilterForRawQuery(query, filterableColumns, qb, metadataColumns);
}

export function addFilter<T>(qb: SelectQueryBuilder<T>, query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }, metadataColumns?: { [column: string]: string }): SelectQueryBuilder<T> {
  const filter = formatFilter(qb, query, filterableColumns, metadataColumns);

  const filterEntries = Object.entries(filter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const orFilters = filterEntries.filter(([_, value]) => value[0].comparator === '$or');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const andFilters = filterEntries.filter(([_, value]) => value[0].comparator === '$and');

  qb.andWhere(
    new Brackets((qb: SelectQueryBuilder<T>) => {
      for (const [column] of orFilters) {
        addWhereCondition(qb, column, filter);
      }
    }),
  );

  for (const [column] of andFilters) {
    qb.andWhere(
      new Brackets((qb: SelectQueryBuilder<T>) => {
        addWhereCondition(qb, column, filter);
      }),
    );
  }

  return qb;
}

export function fixRawColumnFilterValue<T>(column: string, qb: SelectQueryBuilder<T>, metadataColumns?: { [column: string]: string }, isJsonb = false) {
  // Instancier un objet temporaire de T
  const columnType = metadataColumns && metadataColumns[column] ? metadataColumns[column] : 'string';

  return (value: string) => {
    if ((columnType === 'Date' || isJsonb) && isISODate(value)) {
      return new Date(value);
    }

    if ((columnType === 'Number' || isJsonb) && !Number.isNaN(value)) {
      return Number(value);
    }

    return value;
  };
}

// It's only overrided for extractVirtualProperty method.
export function addWhereCondition<T>(qb: SelectQueryBuilder<T>, column: string, filter: ColumnsFilters) {
  const columnProperties = getPropertiesByColumnName(column);

  const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(qb, columnProperties);
  const isRelation = checkIsRelation(qb, columnProperties.propertyPath);
  const isEmbedded = checkIsEmbedded(qb, columnProperties.propertyPath);
  const isArray = checkIsArray(qb, columnProperties.propertyName);

  const alias = fixColumnAlias(columnProperties, qb.alias, isRelation, isVirtualProperty, isEmbedded, virtualQuery);
  filter[column].forEach((columnFilter: Filter, index: number) => {
    const columnNamePerIteration = `${columnProperties.column}${index}`;
    const condition = generatePredicateCondition(qb, columnProperties.column, columnFilter, alias, isVirtualProperty);
    const parameters = fixQueryParam(alias, columnNamePerIteration, columnFilter, condition, {
      [columnNamePerIteration]: columnFilter.findOperator.value,
    });
    if (isArray && condition.parameters?.length && !['not', 'isNull', 'arrayContains'].includes(condition.operator)) {
      condition.parameters[0] = `cardinality(${condition.parameters[0]})`;
    }
    if (columnFilter.comparator === FilterComparator.OR) {
      qb.orWhere(qb['createWhereConditionExpression'](condition), parameters);
    } else {
      qb.andWhere(qb['createWhereConditionExpression'](condition), parameters);
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function extractVirtualProperty(qb: SelectQueryBuilder<unknown>, columnProperties: ColumnProperties): Partial<ColumnMetadata> {
  return {
    isVirtualProperty: false,
    query: undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkIsArray(qb: SelectQueryBuilder<unknown>, propertyName: string): boolean {
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkIsJsonb(qb: SelectQueryBuilder<unknown>, propertyName: string): boolean {
  return false;
}
