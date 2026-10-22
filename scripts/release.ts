import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReleaseTag, packPackage, readPackages} from './packages.ts';
import {runProcess} from './process.ts';

const args = process.argv.slice(2);
const tag = args[0];
if (!tag || args.length > 2 || (args.length === 2 && args[1] !== '--dry-run')) {
  throw new Error(
    'Usage: bun scripts/release.ts hyapi-v<stable-version> [--dry-run]',
  );
}
const dryRun = args[1] === '--dry-run';
const pkg = (await readPackages())[0]!;
assertReleaseTag(tag, pkg);
if (!dryRun && !process.env.NPM_CONFIG_TOKEN?.trim()) {
  throw new Error(
    'NPM_CONFIG_TOKEN is required for publishing to the npm registry.',
  );
}
const distTag = 'latest';
const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
await runProcess('bun', ['run', 'verify'], workspaceRoot);

const root = await mkdtemp(join(tmpdir(), 'hyapi-release-'));
let failure: unknown;
let failed = false;
try {
  console.log(
    `${dryRun ? 'Dry-running' : 'Releasing'} ${pkg.name}@${pkg.version} (npm tag: ${distTag}, access: public)`,
  );
  const archive = await packPackage(pkg, join(root, 'archives'));
  if (dryRun) {
    console.log(`Packed hyapi tarball: ${archive}`);
    console.log(
      'Dry run complete; publisher authentication and registry resolution were not checked.',
    );
  } else {
    const consumer = join(root, 'consumer');
    await mkdir(consumer);
    const dependencies: Record<string, string> = {
      [pkg.name]: `file:${archive.replaceAll('\\', '/')}`,
    };
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify({name: 'hyapi-release-consumer', private: true, dependencies}, null, 2)}\n`,
      'utf8',
    );
    await writeFile(join(consumer, 'bunfig.toml'), 'env = false\n', 'utf8');
    console.log(
      'Checking selected tarball dependencies and peers against the npm registry.',
    );
    await runProcess(
      'bun',
      ['install', '--registry', 'https://registry.npmjs.org/'],
      consumer,
    );
    await runProcess(
      'bun',
      ['publish', '--access', 'public', '--tag', distTag, archive],
      pkg.directory,
    );
  }
} catch (error) {
  failed = true;
  failure = error;
}
try {
  await rm(root, {recursive: true, force: true});
} catch (cleanupError) {
  failure = failed
    ? new AggregateError(
        [failure, cleanupError],
        'Release temporary directory cleanup failed.',
        {
          cause: failure,
        },
      )
    : cleanupError;
  failed = true;
}
if (failed) throw failure;
