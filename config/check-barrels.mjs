import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';

// Standalone port of the monorepo barrel checker.
// Verifies that every source directory exposing modules has an `index.ts` barrel
// re-exporting its siblings. Adapted for a single package: scans `src/` directly
// and ignores test directories and non-source files.

const repoRoot = process.cwd();
const srcRoot = resolve(repoRoot, 'src');

const IGNORED_FILE_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'];
const IGNORED_DIRS = new Set(['__tests__', '__test__', '__mocks__', '__fixtures__']);

function isIgnoredTsFile(filename) {
  return IGNORED_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

function readDirSafe(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).map((name) => resolve(dir, name));
}

function hasTsContentRecursive(dir) {
  for (const entry of readDirSafe(dir)) {
    if (statSync(entry).isDirectory()) {
      if (IGNORED_DIRS.has(basename(entry))) {
        continue;
      }
      if (hasTsContentRecursive(entry)) {
        return true;
      }
      continue;
    }
    if (extname(entry) === '.ts' && basename(entry) !== 'index.ts' && !isIgnoredTsFile(basename(entry))) {
      return true;
    }
  }
  return false;
}

function parseIndexExports(indexPath) {
  const content = readFileSync(indexPath, 'utf8');
  const exportRegex = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]\.\/([^'"]+)['"];?/g;
  const exportsSet = new Set();
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exportsSet.add(match[1]);
  }
  return exportsSet;
}

function expectedExportsForDirectory(dir) {
  const expected = new Set();
  for (const entry of readDirSafe(dir)) {
    const name = basename(entry);
    if (statSync(entry).isDirectory()) {
      if (IGNORED_DIRS.has(name)) {
        continue;
      }
      const childIndex = resolve(entry, 'index.ts');
      if (existsSync(childIndex) && hasTsContentRecursive(entry)) {
        expected.add(name);
      }
      continue;
    }
    if (extname(name) !== '.ts' || name === 'index.ts' || isIgnoredTsFile(name)) {
      continue;
    }
    expected.add(name.slice(0, -3));
  }
  return expected;
}

function walkDirectories(dir, out = []) {
  out.push(dir);
  for (const entry of readDirSafe(dir)) {
    if (statSync(entry).isDirectory() && !IGNORED_DIRS.has(basename(entry))) {
      walkDirectories(entry, out);
    }
  }
  return out;
}

if (!existsSync(srcRoot)) {
  console.log('[barrels:check] no src directory found, skipping');
  process.exit(0);
}

let hasError = false;

for (const dir of walkDirectories(srcRoot)) {
  const expected = expectedExportsForDirectory(dir);
  if (expected.size === 0) {
    continue;
  }

  const indexPath = resolve(dir, 'index.ts');
  const relativeDir = dir.slice(repoRoot.length + 1).replace(/\\/g, '/');

  if (!existsSync(indexPath)) {
    console.error(`[barrels:check] missing index.ts in ${relativeDir}`);
    hasError = true;
    continue;
  }

  const actual = parseIndexExports(indexPath);
  const missing = [...expected].filter((item) => !actual.has(item));
  const unexpected = [...actual].filter((item) => !expected.has(item));

  if (missing.length) {
    console.error(`[barrels:check] ${relativeDir}: missing exports -> ${missing.join(', ')}`);
    hasError = true;
  }
  if (unexpected.length) {
    console.error(`[barrels:check] ${relativeDir}: unexpected exports -> ${unexpected.join(', ')}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log('[barrels:check] all barrel files are in sync');
