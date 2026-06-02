import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Standalone port of the monorepo dependency policy:
// for a publishable library, framework packages (@nestjs/*) and rxjs must live in
// peerDependencies — never in dependencies — so consumers control a single instance.

const packageJsonPath = resolve(process.cwd(), 'package.json');

if (!existsSync(packageJsonPath)) {
  console.error('[deps:check] no package.json found');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
let hasError = false;

const runtimeDeps = pkg.dependencies ?? {};
for (const name of Object.keys(runtimeDeps)) {
  if (name.startsWith('@nestjs/') || name === 'rxjs') {
    console.error(`[deps:check] ${pkg.name}: move ${name} from dependencies to peerDependencies for a publishable lib`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log('[deps:check] dependency policy passed');
