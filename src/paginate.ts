/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { ServiceUnavailableException } from '@nestjs/common';
import { PaginateConfig as OPaginateConfig, Paginated, PaginateQuery, PaginationLimit, PaginationType } from 'nestjs-paginate';
import { Column, positiveNumberOrDefault, SortBy, isEntityKey, Order, getPropertiesByColumnName, checkIsRelation, checkIsEmbedded, fixColumnAlias, includesAllPrimaryKeyColumns, getQueryUrlComponents, isISODate, ColumnProperties, getPaddedExpr } from 'nestjs-paginate/lib/helper';
import { FilterComparator, FilterOperator, FilterQuantifier, FilterSuffix, fixQueryParam, generatePredicateCondition, isOperator, isSuffix, OperatorSymbolToFunction, parseFilter, parseFilterToken } from 'nestjs-paginate/lib/filter';
import { Brackets, FindOperator, JsonContains, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { mapKeys } from 'lodash';
import { stringify } from 'querystring';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { WherePredicateOperator } from 'typeorm/query-builder/WhereClause';
import globalConfig from 'nestjs-paginate/lib/global-config';

export type RawPaginateConfig<T> = Omit<OPaginateConfig<T>, 'where' | 'relations' | 'loadEagerRelations'> & {
  metadataColumns?: {
    [key: string]: string;
  };
};

// ---------------------------------------------------------------------------
// Cursor pagination — faithful port of nestjs-paginate's encoders.
// The only adaptation for raw mode is the column-type detection: the official
// reads it from the entity metadata, here we read it from `config.metadataColumns`.
// ---------------------------------------------------------------------------

function fixCursorValue(value: unknown): unknown {
  if (typeof value === 'string' && isISODate(value)) {
    return new Date(value);
  }
  return value;
}

function generateNullCursor(): string {
  return 'A' + '0'.repeat(15); // null values should be looked up last, so use the smallest prefix
}

function generateDateCursor(value: number, direction: 'ASC' | 'DESC'): string {
  if (direction === 'ASC' && value === 0) {
    return 'X' + '0'.repeat(15);
  }

  const finalValue = direction === 'ASC' ? Math.pow(10, 15) - value : value;

  return 'V' + String(finalValue).padStart(15, '0');
}

function generateNumberCursor(value: number, direction: 'ASC' | 'DESC'): string {
  const integerLength = 11;
  const decimalLength = 4; // sorting is not possible if the decimal point exceeds 4 digits
  const maxIntegerDigit = Math.pow(10, integerLength);
  const fixedScale = Math.pow(10, decimalLength);
  const absValue = Math.abs(value);
  const scaledValue = Math.round(absValue * fixedScale);
  const integerPart = Math.floor(scaledValue / fixedScale);
  const decimalPart = scaledValue % fixedScale;

  let integerPrefix: string;
  let decimalPrefix: string;
  let finalInteger: number;
  let finalDecimal: number;

  if (direction === 'ASC') {
    if (value < 0) {
      integerPrefix = 'Y';
      decimalPrefix = 'V';
      finalInteger = integerPart;
      finalDecimal = decimalPart;
    } else if (value === 0) {
      integerPrefix = 'X';
      decimalPrefix = 'X';
      finalInteger = 0;
      finalDecimal = 0;
    } else {
      integerPrefix = integerPart === 0 ? 'X' : 'V'; // X > V
      decimalPrefix = decimalPart === 0 ? 'X' : 'V'; // X > V
      finalInteger = integerPart === 0 ? 0 : maxIntegerDigit - integerPart;
      finalDecimal = decimalPart === 0 ? 0 : fixedScale - decimalPart;
    }
  } else {
    // DESC
    if (value < 0) {
      integerPrefix = integerPart === 0 ? 'N' : 'M'; // N > M
      decimalPrefix = decimalPart === 0 ? 'X' : 'V'; // X > V
      finalInteger = integerPart === 0 ? 0 : maxIntegerDigit - integerPart;
      finalDecimal = decimalPart === 0 ? 0 : fixedScale - decimalPart;
    } else if (value === 0) {
      integerPrefix = 'N';
      decimalPrefix = 'X';
      finalInteger = 0;
      finalDecimal = 0;
    } else {
      integerPrefix = 'V';
      decimalPrefix = 'V';
      finalInteger = integerPart;
      finalDecimal = decimalPart;
    }
  }

  return integerPrefix + String(finalInteger).padStart(integerLength, '0') + decimalPrefix + String(finalDecimal).padStart(decimalLength, '0');
}

function isDateMetadataColumn(metadataColumns: { [column: string]: string } | undefined, column: string): boolean {
  const type = metadataColumns?.[column];
  return typeof type === 'string' && type.toLowerCase() === 'date';
}

// Raw equivalent of the official `generateCursor`: raw rows are flat objects keyed by
// the SELECT alias, so we read `item[column]` directly instead of traversing relations.
function generateRawCursor<T extends ObjectLiteral>(item: T, sortBy: SortBy<T>, metadataColumns?: { [column: string]: string }): string {
  return sortBy
    .map(([column, direction]) => {
      const value = fixCursorValue((item as Record<string, unknown>)[String(column)]);

      if (value === null || value === undefined) {
        return generateNullCursor();
      }

      if (isDateMetadataColumn(metadataColumns, String(column))) {
        return generateDateCursor(new Date(value as string | number | Date).getTime(), direction);
      }

      return generateNumberCursor(Number(value), direction);
    })
    .join('');
}

export async function rawPaginate<T extends ObjectLiteral>(query: PaginateQuery, qb: SelectQueryBuilder<T>, config: RawPaginateConfig<T>): Promise<Paginated<T>> {
  const page = positiveNumberOrDefault(query.page, 1, 1);

  const defaultLimit = config.defaultLimit || globalConfig.defaultLimit;
  const maxLimit = config.maxLimit || globalConfig.defaultMaxLimit;
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
    } else if (config.paginationType === PaginationType.CURSOR) {
      queryBuilder.take(limit);
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

  const isCursorPagination = isPaginated && config.paginationType === PaginationType.CURSOR;

  if (isCursorPagination) {
    // Cursor pagination — port of the official SQL expression builders. The column-type
    // detection (date vs number) comes from `config.metadataColumns` instead of entity metadata.
    const padLength = 15;
    const integerLength = 11;
    const decimalLength = 4;
    const fixedScale = Math.pow(10, decimalLength);
    const maxIntegerDigit = Math.pow(10, integerLength);

    const concat = (parts: string[]): string => (isMMDb ? `CONCAT(${parts.join(', ')})` : parts.join(' || '));

    const getDateColumnExpression = (columnAlias: string): string => {
      switch (dbType) {
        case 'mysql':
        case 'mariadb':
          return `UNIX_TIMESTAMP(${columnAlias}) * 1000`;
        case 'postgres':
          return `EXTRACT(EPOCH FROM ${columnAlias}) * 1000`;
        case 'sqlite':
          return `(STRFTIME('%s', ${columnAlias}) + (STRFTIME('%f', ${columnAlias}) - STRFTIME('%S', ${columnAlias}))) * 1000`;
        default:
          return columnAlias;
      }
    };

    const generateNullCursorExpr = (): string => {
      const zeroPaddedExpr = getPaddedExpr('0', padLength, dbType);
      const prefix = 'A';

      return isMMDb ? `CONCAT('${prefix}', ${zeroPaddedExpr})` : `'${prefix}' || ${zeroPaddedExpr}`;
    };

    const generateDateCursorExpr = (columnExpr: string, direction: 'ASC' | 'DESC'): string => {
      const safeExpr = `COALESCE(${columnExpr}, 0)`;
      const sqlExpr = direction === 'ASC' ? `POW(10, ${padLength}) - ${safeExpr}` : safeExpr;

      const paddedExpr = getPaddedExpr(sqlExpr, padLength, dbType);
      const zeroPaddedExpr = getPaddedExpr('0', padLength, dbType);

      const prefixNull = "'A'";
      const prefixValue = "'V'";
      const prefixZero = "'X'";

      if (direction === 'ASC') {
        return `CASE
                        WHEN ${columnExpr} IS NULL THEN ${concat([prefixNull, zeroPaddedExpr])}
                        WHEN ${columnExpr} = 0 THEN ${concat([prefixZero, zeroPaddedExpr])}
                        ELSE ${concat([prefixValue, paddedExpr])}
                    END`;
      } else {
        return `CASE
                        WHEN ${columnExpr} IS NULL THEN ${concat([prefixNull, zeroPaddedExpr])}
                        ELSE ${concat([prefixValue, paddedExpr])}
                    END`;
      }
    };

    const generateNumberCursorExpr = (columnExpr: string, direction: 'ASC' | 'DESC'): string => {
      const safeExpr = `COALESCE(${columnExpr}, 0)`;
      const absSafeExpr = `ABS(${safeExpr})`;
      const scaledExpr = `ROUND(${absSafeExpr} * ${fixedScale}, 0)`;
      const intExpr = `FLOOR(${scaledExpr} / ${fixedScale})`;
      const decExpr = `(${scaledExpr} % ${fixedScale})`;
      const reversedIntExpr = `(${maxIntegerDigit} - ${intExpr})`;
      const reversedDecExpr = `(${fixedScale} - ${decExpr})`;

      const paddedIntExpr = getPaddedExpr(intExpr, integerLength, dbType);
      const paddedDecExpr = getPaddedExpr(decExpr, decimalLength, dbType);
      const reversedIntPaddedExpr = getPaddedExpr(reversedIntExpr, integerLength, dbType);
      const reversedDecPaddedExpr = getPaddedExpr(reversedDecExpr, decimalLength, dbType);
      const zeroPaddedIntExpr = getPaddedExpr('0', integerLength, dbType);
      const zeroPaddedDecExpr = getPaddedExpr('0', decimalLength, dbType);

      if (direction === 'ASC') {
        return `CASE
                        WHEN ${columnExpr} IS NULL THEN ${generateNullCursorExpr()}
                        WHEN ${columnExpr} < 0 THEN ${concat(["'Y'", paddedIntExpr, "'V'", paddedDecExpr])}
                        WHEN ${columnExpr} = 0 THEN ${concat(["'X'", zeroPaddedIntExpr, "'X'", zeroPaddedDecExpr])}
                        WHEN ${columnExpr} > 0 AND ${intExpr} = 0 AND ${decExpr} > 0 THEN ${concat(["'X'", zeroPaddedIntExpr, "'V'", reversedDecPaddedExpr])}
                        WHEN ${columnExpr} > 0 AND ${intExpr} > 0 AND ${decExpr} = 0 THEN ${concat(["'V'", reversedIntPaddedExpr, "'X'", zeroPaddedDecExpr])}
                        WHEN ${columnExpr} > 0 AND ${intExpr} > 0 AND ${decExpr} > 0 THEN ${concat(["'V'", reversedIntPaddedExpr, "'V'", reversedDecPaddedExpr])}
                    END`;
      } else {
        return `CASE
                        WHEN ${columnExpr} IS NULL THEN ${generateNullCursorExpr()}
                        WHEN ${columnExpr} < 0 AND ${intExpr} > 0 AND ${decExpr} > 0 THEN ${concat(["'M'", reversedIntPaddedExpr, "'V'", reversedDecPaddedExpr])}
                        WHEN ${columnExpr} < 0 AND ${intExpr} > 0 AND ${decExpr} = 0 THEN ${concat(["'M'", reversedIntPaddedExpr, "'X'", zeroPaddedDecExpr])}
                        WHEN ${columnExpr} < 0 AND ${intExpr} = 0 AND ${decExpr} > 0 THEN ${concat(["'N'", zeroPaddedIntExpr, "'V'", reversedDecPaddedExpr])}
                        WHEN ${columnExpr} = 0 THEN ${concat(["'N'", zeroPaddedIntExpr, "'X'", zeroPaddedDecExpr])}
                        WHEN ${columnExpr} > 0 THEN ${concat(["'V'", paddedIntExpr, "'V'", paddedDecExpr])}
                    END`;
      }
    };

    const cursorExpressions = sortBy.map(([column, direction]) => {
      const columnProperties = getPropertiesByColumnName(String(column));
      const alias = fixColumnAlias(columnProperties, queryBuilder.alias, false, false, false);
      const isDate = isDateMetadataColumn(config.metadataColumns, String(column));
      const columnExpr = isDate ? getDateColumnExpression(alias) : alias;

      return isDate ? generateDateCursorExpr(columnExpr, direction) : generateNumberCursorExpr(columnExpr, direction);
    });

    const cursorExpression = cursorExpressions.length > 1 ? (isMMDb ? `CONCAT(${cursorExpressions.join(', ')})` : cursorExpressions.join(' || ')) : cursorExpressions[0];
    queryBuilder.addSelect(cursorExpression, 'cursor');

    if (query.cursor) {
      queryBuilder.andWhere(`${cursorExpression} < :cursor`, { cursor: query.cursor });
    }

    // `cursor` is a reserved word in mysql, wrap it in backticks to recognize it as an alias.
    isMMDb ? queryBuilder.orderBy('`cursor`', 'DESC') : queryBuilder.orderBy('cursor', 'DESC');
  } else {
    for (const order of sortBy) {
      const columnProperties = getPropertiesByColumnName(order[0]);
      const { isVirtualProperty } = extractVirtualProperty(queryBuilder, columnProperties);

      const isRelation = checkIsRelation(queryBuilder, columnProperties.propertyPath!);
      const isEmbeded = checkIsEmbedded(queryBuilder, columnProperties.propertyPath!);
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
  }

  // When we partial select the columns (main or relation) we must add the primary key column otherwise
  // typeorm will not be able to map the result.
  let selectParams = config.select && query.select && !config.ignoreSelectInQueryParam ? config.select.filter((column) => query.select?.includes(column)) : config.select;
  if (query.select && !includesAllPrimaryKeyColumns(queryBuilder, query.select)) {
    selectParams = config.select;
  }
  if (selectParams && selectParams?.length > 0 && includesAllPrimaryKeyColumns(queryBuilder, selectParams)) {
    const cols: string[] = selectParams.reduce((cols: string[], currentCol) => {
      const columnProperties = getPropertiesByColumnName(currentCol);
      const isRelation = checkIsRelation(queryBuilder, columnProperties.propertyPath!);
      const alias = fixColumnAlias(columnProperties, queryBuilder.alias, isRelation);
      cols.push(alias);

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
            const isRelation = checkIsRelation(qb, property.propertyPath!);
            const isEmbedded = checkIsEmbedded(qb, property.propertyPath!);
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
          const searchWords = query.search?.split(' ').filter((word) => word.length > 0);
          searchWords?.forEach((searchWord, index) => {
            qb.andWhere(
              new Brackets((subQb: SelectQueryBuilder<T>) => {
                for (const column of searchBy) {
                  const property = getPropertiesByColumnName(column);
                  const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(subQb, property);
                  const isRelation = checkIsRelation(subQb, property.propertyPath!);
                  const isEmbedded = checkIsEmbedded(subQb, property.propertyPath!);
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
  } else if (isCursorPagination) {
    // Cursor pagination intentionally skips the count query (totalItems is not exposed).
    items = await queryBuilder.getRawMany<T>();
  } else if (isPaginated) {
    items = await queryBuilder.getRawMany<T>(); //
    totalItems = await getCount(queryBuilder);
  } else {
    items = await queryBuilder.getRawMany<T>();
  }

  // The SQL-computed `cursor` column is only needed for WHERE/ORDER BY; strip it from the output.
  if (isCursorPagination) {
    for (const item of items) {
      delete (item as Record<string, unknown>).cursor;
    }
  }
  const sortByQuery = sortBy.map((order) => `&sortBy=${order.join(':')}`).join('');
  const searchQuery = query.search ? `&search=${query.search}` : '';

  const searchByQuery = query.searchBy && searchBy.length && !config.ignoreSearchByInQueryParam ? searchBy.map((column) => `&searchBy=${column}`).join('') : '';

  // Only expose select in meta data if query select differs from config select
  const isQuerySelected = selectParams?.length !== config.select?.length;
  const selectQuery = isQuerySelected ? `&select=${selectParams?.join(',')}` : '';

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

  let path: string | null = null;
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

  const reversedSortBy = sortBy.map(([col, dir]) => [col, dir === 'ASC' ? 'DESC' : 'ASC'] as Order<T>);

  const buildLinkForCursor = (cursor: string | undefined, isReversed = false): string => {
    let adjustedOptions = options;

    if (isReversed && sortBy.length > 0) {
      const reversedSortByQuery = reversedSortBy.map((order) => `&sortBy=${order.join(':')}`).join('');
      adjustedOptions = `&limit=${limit}${reversedSortByQuery}${searchQuery}${searchByQuery}${selectQuery}${filterQuery}`;
    }

    return path + adjustedOptions.replace(/^./, '?') + (cursor ? `&cursor=${cursor}` : '');
  };

  const totalPages = isPaginated ? Math.ceil(totalItems / limit) : 1;

  const results: Paginated<T> = {
    data: items,
    meta: {
      itemsPerPage: isCursorPagination ? items.length : limit === PaginationLimit.COUNTER_ONLY ? totalItems : isPaginated ? limit : items.length,
      totalItems: isCursorPagination ? undefined : limit === PaginationLimit.COUNTER_ONLY || isPaginated ? totalItems : items.length,
      currentPage: isCursorPagination ? undefined : page,
      totalPages: isCursorPagination ? undefined : totalPages,
      sortBy,
      search: query.search!,
      searchBy: query.search ? searchBy : [],
      select: isQuerySelected ? selectParams || [] : [],
      filter: query.filter,
      cursor: isCursorPagination ? query.cursor : undefined,
    },
    // If there is no `path`, don't build links.
    links:
      path !== null
        ? isCursorPagination
          ? {
              previous: items.length ? buildLinkForCursor(generateRawCursor(items[0], reversedSortBy, config.metadataColumns), true) : undefined,
              current: buildLinkForCursor(query.cursor),
              next: items.length ? buildLinkForCursor(generateRawCursor(items[items.length - 1], sortBy, config.metadataColumns), false) : undefined,
            }
          : {
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

type Filter = { quantifier: FilterQuantifier; comparator: FilterComparator; findOperator: FindOperator<string> };
type ColumnsFilters = { [columnName: string]: Filter[] };

export function parseFilterForRawQuery<T extends ObjectLiteral>(query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }, qb?: SelectQueryBuilder<T>, metadataColumns?: { [column: string]: string }): ColumnsFilters {
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
        quantifier: token.quantifier,
        comparator: token.comparator,
        findOperator: undefined!,
      };
      const fixValue = fixRawColumnFilterValue(column, qb!, metadataColumns);

      const columnProperties = getPropertiesByColumnName(column);
      const isJsonb = checkIsJsonb(qb!, columnProperties.column);

      switch (token.operator) {
        case FilterOperator.BTW:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)!(...token.value.split(',').map(fixValue));
          break;
        case FilterOperator.IN:
        case FilterOperator.CONTAINS:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)!(token.value.split(','));
          break;
        case FilterOperator.ILIKE:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)!(`%${token.value}%`);
          break;
        case FilterOperator.SW:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)!(`${token.value}%`);
          break;
        default:
          params.findOperator = OperatorSymbolToFunction.get(token.operator)!(fixValue(token.value));
      }

      if (isJsonb) {
        const parts = column.split('.');
        const dbColumnName = parts[parts.length - 2];
        const jsonColumnName = parts[parts.length - 1];

        const jsonFixValue = fixRawColumnFilterValue(column, qb!, metadataColumns, true);

        const jsonParams = {
          quantifier: params.quantifier,
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
        filter[column][lastFilterElement].findOperator = OperatorSymbolToFunction.get(token.suffix)!(filter[column][lastFilterElement].findOperator);
      }
    }
  }
  return filter;
}

export function formatFilter<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }, metadataColumns?: { [column: string]: string }) {
  if (qb?.expressionMap?.mainAlias?.hasMetadata) {
    return parseFilter(query, filterableColumns, qb);
  }
  return parseFilterForRawQuery(query, filterableColumns, qb, metadataColumns);
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export function addFilter<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, query: PaginateQuery, filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true } | any, metadataColumns?: { [column: string]: string }): SelectQueryBuilder<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
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

export function fixRawColumnFilterValue<T extends ObjectLiteral>(column: string, qb: SelectQueryBuilder<T>, metadataColumns?: { [column: string]: string }, isJsonb = false) {
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
export function addWhereCondition<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, column: string, filter: ColumnsFilters) {
  const columnProperties = getPropertiesByColumnName(column);

  const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(qb, columnProperties);
  const isRelation = checkIsRelation(qb, columnProperties.propertyPath!);
  const isEmbedded = checkIsEmbedded(qb, columnProperties.propertyPath!);
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
export function extractVirtualProperty<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, columnProperties: ColumnProperties): Partial<ColumnMetadata> {
  return {
    isVirtualProperty: false,
    query: undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkIsArray<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, propertyName: string): boolean {
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkIsJsonb<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, propertyName: string): boolean {
  return false;
}
