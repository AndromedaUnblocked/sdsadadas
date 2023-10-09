import { Project } from 'ts-morph';
import { readFileSync, promises as fs } from 'fs';
import { basename, dirname, extname, join, relative, sep } from 'path';
import {
  debug,
  download,
  execCommand,
  FileBlob,
  FileFsRef,
  getEnvForPackageManager,
  getNodeVersion,
  getSpawnOptions,
  glob,
  EdgeFunction,
  NodejsLambda,
  runNpmInstall,
  runPackageJsonScript,
  scanParentDirs,
} from '@vercel/build-utils';
import { getConfig } from '@vercel/static-config';
import { nodeFileTrace } from '@vercel/nft';
import type {
  BuildV2,
  Files,
  NodeVersion,
  PackageJson,
  BuildResultV2Typical,
} from '@vercel/build-utils';
import type { ConfigRoute } from '@remix-run/dev/dist/config/routes';
import type { BaseFunctionConfig } from '@vercel/static-config';
import {
  calculateRouteConfigHash,
  findConfig,
  getPathFromRoute,
  getRegExpFromPath,
  getResolvedRouteConfig,
  isLayoutRoute,
  ResolvedRouteConfig,
  ResolvedNodeRouteConfig,
  ResolvedEdgeRouteConfig,
  findEntry,
  chdirAndReadConfig,
  addDependencies,
  resolveSemverMinMax,
  ensureResolvable,
  isESM,
} from './utils';
import { patchHydrogenServer } from './hydrogen';

interface ServerBundle {
  serverBuildPath: string;
  routes: string[];
}

const remixBuilderPkg = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
);
const remixRunDevForkVersion =
  remixBuilderPkg.devDependencies['@remix-run/dev'];

const DEFAULTS_PATH = join(__dirname, '../defaults');

const edgeServerSrcPromise = fs.readFile(
  join(DEFAULTS_PATH, 'server-edge.mjs'),
  'utf-8'
);
const nodeServerSrcPromise = fs.readFile(
  join(DEFAULTS_PATH, 'server-node.mjs'),
  'utf-8'
);

// Minimum supported version of the `@vercel/remix` package
const VERCEL_REMIX_MIN_VERSION = '1.10.0';

// Minimum supported version of the `@vercel/remix-run-dev` forked compiler
const REMIX_RUN_DEV_MIN_VERSION = '1.15.0';

// Maximum version of `@vercel/remix-run-dev` fork
// (and also `@vercel/remix` since they get published at the same time)
const REMIX_RUN_DEV_MAX_VERSION = remixRunDevForkVersion.slice(
  remixRunDevForkVersion.lastIndexOf('@') + 1
);

export const build: BuildV2 = async ({
  entrypoint,
  files,
  workPath,
  repoRootPath,
  config,
  meta = {},
}) => {
  const { installCommand, buildCommand } = config;

  await download(files, workPath, meta);

  const mountpoint = dirname(entrypoint);
  const entrypointFsDirname = join(workPath, mountpoint);

  // Run "Install Command"
  const nodeVersion = await getNodeVersion(
    entrypointFsDirname,
    undefined,
    config,
    meta
  );

  const { cliType, packageJsonPath, lockfileVersion } = await scanParentDirs(
    entrypointFsDirname
  );

  if (!packageJsonPath) {
    throw new Error('Failed to locate `package.json` file in your project');
  }

  const pkgRaw = await fs.readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);

  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  if (!spawnOpts.env) {
    spawnOpts.env = {};
  }

  spawnOpts.env = getEnvForPackageManager({
    cliType,
    lockfileVersion,
    nodeVersion,
    env: spawnOpts.env,
  });

  if (typeof installCommand === 'string') {
    if (installCommand.trim()) {
      console.log(`Running "install" command: \`${installCommand}\`...`);
      await execCommand(installCommand, {
        ...spawnOpts,
        cwd: entrypointFsDirname,
      });
    } else {
      console.log(`Skipping "install" command...`);
    }
  } else {
    await runNpmInstall(entrypointFsDirname, [], spawnOpts, meta, nodeVersion);
  }

  const isHydrogen2 = Boolean(
    pkg.dependencies?.['@shopify/remix-oxygen'] ||
      pkg.devDependencies?.['@shopify/remix-oxygen']
  );

  // Determine the version of Remix based on the `@remix-run/dev`
  // package version.
  const remixRunDevPath = await ensureResolvable(
    entrypointFsDirname,
    repoRootPath,
    '@remix-run/dev'
  );
  const remixRunDevPkg = JSON.parse(
    readFileSync(join(remixRunDevPath, 'package.json'), 'utf8')
  );
  const remixVersion = remixRunDevPkg.version;

  const remixConfig = await chdirAndReadConfig(
    remixRunDevPath,
    entrypointFsDirname,
    packageJsonPath
  );
  const { serverEntryPoint, appDirectory } = remixConfig;
  const remixRoutes = Object.values(remixConfig.routes);

  const depsToAdd: string[] = [];

  const remixRunDevPkgVersion: string | undefined =
    pkg.dependencies?.['@remix-run/dev'] ||
    pkg.devDependencies?.['@remix-run/dev'];

  // Override the official `@remix-run/dev` package with the
  // Vercel fork, which supports the `serverBundles` config
  if (
    !isHydrogen2 &&
    remixRunDevPkg.name !== '@vercel/remix-run-dev' &&
    !remixRunDevPkgVersion?.startsWith('https:')
  ) {
    const remixDevForkVersion = resolveSemverMinMax(
      REMIX_RUN_DEV_MIN_VERSION,
      REMIX_RUN_DEV_MAX_VERSION,
      remixVersion
    );
    depsToAdd.push(
      `@remix-run/dev@npm:@vercel/remix-run-dev@${remixDevForkVersion}`
    );
  }

  // `app/entry.server.tsx` and `app/entry.client.tsx` are optional in Remix,
  // so if either of those files are missing then add our own versions.
  const userEntryServerFile = findEntry(appDirectory, 'entry.server');
  if (!userEntryServerFile) {
    await fs.copyFile(
      join(DEFAULTS_PATH, 'entry.server.jsx'),
      join(appDirectory, 'entry.server.jsx')
    );
    if (!pkg.dependencies['@vercel/remix']) {
      // Dependency version resolution logic
      // 1. Users app is on 1.9.0 -> we install the 1.10.0 (minimum) version of `@vercel/remix`.
      // 2. Users app is on 1.11.0 (a version greater than 1.10.0 and less than the known max
      //    published version) -> we install the (matching) 1.11.0 version of `@vercel/remix`.
      // 3. Users app is on something greater than our latest version of the fork -> we install
      //    the latest known published version of `@vercel/remix`.
      const vercelRemixVersion = resolveSemverMinMax(
        VERCEL_REMIX_MIN_VERSION,
        REMIX_RUN_DEV_MAX_VERSION,
        remixVersion
      );
      depsToAdd.push(`@vercel/remix@${vercelRemixVersion}`);
    }
  }

  if (depsToAdd.length) {
    await addDependencies(cliType, depsToAdd, {
      ...spawnOpts,
      cwd: entrypointFsDirname,
    });
  }

  const userEntryClientFile = findEntry(
    remixConfig.appDirectory,
    'entry.client'
  );
  if (!userEntryClientFile) {
    await fs.copyFile(
      join(DEFAULTS_PATH, 'entry.client.react.jsx'),
      join(appDirectory, 'entry.client.jsx')
    );
  }

  let remixConfigWrapped = false;
  let serverEntryPointAbs: string | undefined;
  let originalServerEntryPoint: string | undefined;
  const remixConfigPath = findConfig(entrypointFsDirname, 'remix.config');
  const renamedRemixConfigPath = remixConfigPath
    ? `${remixConfigPath}.original${extname(remixConfigPath)}`
    : undefined;

  // These get populated inside the try/catch below
  let serverBundles: ServerBundle[];
  const serverBundlesMap = new Map<string, ConfigRoute[]>();
  const resolvedConfigsMap = new Map<ConfigRoute, ResolvedRouteConfig>();

  try {
    // Read the `export const config` (if any) for each route
    const project = new Project();
    const staticConfigsMap = new Map<ConfigRoute, BaseFunctionConfig | null>();
    for (const route of remixRoutes) {
      const routePath = join(remixConfig.appDirectory, route.file);
      let staticConfig = getConfig(project, routePath);
      if (staticConfig && isHydrogen2) {
        console.log(
          'WARN: `export const config` is currently not supported for Hydrogen v2 apps'
        );
        staticConfig = null;
      }
      staticConfigsMap.set(route, staticConfig);
    }

    for (const route of remixRoutes) {
      const config = getResolvedRouteConfig(
        route,
        remixConfig.routes,
        staticConfigsMap,
        isHydrogen2
      );
      resolvedConfigsMap.set(route, config);
    }

    // Figure out which routes belong to which server bundles
    // based on having common static config properties
    for (const route of remixRoutes) {
      if (isLayoutRoute(route.id, remixRoutes)) continue;

      const config = resolvedConfigsMap.get(route);
      if (!config) {
        throw new Error(`Expected resolved config for "${route.id}"`);
      }
      const hash = calculateRouteConfigHash(config);

      let routesForHash = serverBundlesMap.get(hash);
      if (!Array.isArray(routesForHash)) {
        routesForHash = [];
        serverBundlesMap.set(hash, routesForHash);
      }

      routesForHash.push(route);
    }

    serverBundles = Array.from(serverBundlesMap.entries()).map(
      ([hash, routes]) => {
        const runtime = resolvedConfigsMap.get(routes[0])?.runtime ?? 'nodejs';
        return {
          serverBuildPath: isHydrogen2
            ? relative(entrypointFsDirname, remixConfig.serverBuildPath)
            : `${relative(
                entrypointFsDirname,
                dirname(remixConfig.serverBuildPath)
              )}/build-${runtime}-${hash}.js`,
          routes: routes.map(r => r.id),
        };
      }
    );

    // We need to patch the `remix.config.js` file to force some values necessary
    // for a build that works on either Node.js or the Edge runtime
    if (!isHydrogen2 && remixConfigPath && renamedRemixConfigPath) {
      await fs.rename(remixConfigPath, renamedRemixConfigPath);

      let patchedConfig: string;
      // Figure out if the `remix.config` file is using ESM syntax
      if (isESM(renamedRemixConfigPath)) {
        patchedConfig = `import config from './${basename(
          renamedRemixConfigPath
        )}';
config.serverBuildTarget = undefined;
config.serverModuleFormat = '${pkg.type === 'module' ? 'esm' : 'cjs'}';
config.serverPlatform = 'node';
config.serverBuildPath = undefined;
config.serverBundles = ${JSON.stringify(serverBundles)};
export default config;`;
      } else {
        patchedConfig = `const config = require('./${basename(
          renamedRemixConfigPath
        )}');
config.serverBuildTarget = undefined;
config.serverModuleFormat = '${pkg.type === 'module' ? 'esm' : 'cjs'}';
config.serverPlatform = 'node';
config.serverBuildPath = undefined;
config.serverBundles = ${JSON.stringify(serverBundles)};
module.exports = config;`;
      }
      await fs.writeFile(remixConfigPath, patchedConfig);
      remixConfigWrapped = true;
    }

    // For Hydrogen v2, patch the `server.ts` file to be Vercel-compatible
    if (isHydrogen2) {
      if (remixConfig.serverEntryPoint) {
        serverEntryPointAbs = join(
          entrypointFsDirname,
          remixConfig.serverEntryPoint
        );
        originalServerEntryPoint = await fs.readFile(
          serverEntryPointAbs,
          'utf8'
        );
        const patchedServerEntryPoint = patchHydrogenServer(
          project,
          serverEntryPointAbs
        );
        if (patchedServerEntryPoint) {
          debug(
            `Patched Hydrogen server file: ${remixConfig.serverEntryPoint}`
          );
          await fs.writeFile(serverEntryPointAbs, patchedServerEntryPoint);
        }
      } else {
        console.log('WARN: No "server" field found in Remix config');
      }
    }

    // Make `remix build` output production mode
    spawnOpts.env.NODE_ENV = 'production';

    // Run "Build Command"
    if (buildCommand) {
      debug(`Executing build command "${buildCommand}"`);
      await execCommand(buildCommand, {
        ...spawnOpts,
        cwd: entrypointFsDirname,
      });
    } else {
      if (hasScript('vercel-build', pkg)) {
        debug(`Executing "yarn vercel-build"`);
        await runPackageJsonScript(
          entrypointFsDirname,
          'vercel-build',
          spawnOpts
        );
      } else if (hasScript('build', pkg)) {
        debug(`Executing "yarn build"`);
        await runPackageJsonScript(entrypointFsDirname, 'build', spawnOpts);
      } else {
        await execCommand('remix build', {
          ...spawnOpts,
          cwd: entrypointFsDirname,
        });
      }
    }
  } finally {
    const cleanupOps: Promise<void>[] = [];
    // Clean up our patched `remix.config.js` to be polite
    if (remixConfigWrapped && remixConfigPath && renamedRemixConfigPath) {
      cleanupOps.push(
        fs
          .rename(renamedRemixConfigPath, remixConfigPath)
          .then(() =>
            debug(`Restored original "${basename(remixConfigPath)}" file`)
          )
      );
    }
    // Restore original server entrypoint if it was modified (for Hydrogen v2)
    if (serverEntryPointAbs && originalServerEntryPoint) {
      cleanupOps.push(
        fs
          .writeFile(serverEntryPointAbs, originalServerEntryPoint)
          .then(() =>
            debug(`Restored original "${basename(serverEntryPointAbs!)}" file`)
          )
      );
    }
    await Promise.all(cleanupOps);
  }

  // This needs to happen before we run NFT to create the Node/Edge functions
  await Promise.all([
    ensureResolvable(
      entrypointFsDirname,
      repoRootPath,
      '@remix-run/server-runtime'
    ),
    !isHydrogen2
      ? ensureResolvable(entrypointFsDirname, repoRootPath, '@remix-run/node')
      : null,
  ]);

  const staticDir = join(
    remixConfig.assetsBuildDirectory,
    ...remixConfig.publicPath
      .replace(/^\/|\/$/g, '')
      .split('/')
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(_ => '..')
  );
  const [staticFiles, ...functions] = await Promise.all([
    glob('**', staticDir),
    ...serverBundles.map(bundle => {
      const firstRoute = remixConfig.routes[bundle.routes[0]];
      const config = resolvedConfigsMap.get(firstRoute) ?? {
        runtime: 'nodejs',
      };

      if (config.runtime === 'edge') {
        return createRenderEdgeFunction(
          entrypointFsDirname,
          repoRootPath,
          join(entrypointFsDirname, bundle.serverBuildPath),
          serverEntryPoint,
          remixVersion,
          config
        );
      }

      return createRenderNodeFunction(
        nodeVersion,
        entrypointFsDirname,
        repoRootPath,
        join(entrypointFsDirname, bundle.serverBuildPath),
        serverEntryPoint,
        remixVersion,
        config
      );
    }),
  ]);

  const output: BuildResultV2Typical['output'] = staticFiles;
  const routes: any[] = [
    {
      src: '^/build/(.*)$',
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      continue: true,
    },
    {
      handle: 'filesystem',
    },
  ];

  for (const route of remixRoutes) {
    // Layout routes don't get a function / route added
    if (isLayoutRoute(route.id, remixRoutes)) continue;

    const { path, rePath } = getPathFromRoute(route, remixConfig.routes);

    // If the route is a pathless layout route (at the root level)
    // and doesn't have any sub-routes, then a function should not be created.
    if (!path) {
      continue;
    }

    const funcIndex = serverBundles.findIndex(bundle => {
      return bundle.routes.includes(route.id);
    });
    const func = functions[funcIndex];

    if (!func) {
      throw new Error(`Could not determine server bundle for "${route.id}"`);
    }

    output[path] =
      func instanceof EdgeFunction
        ? // `EdgeFunction` currently requires the "name" property to be set.
          // Ideally this property will be removed, at which point we can
          // return the same `edgeFunction` instance instead of creating a
          // new one for each page.
          new EdgeFunction({
            ...func,
            name: path,
          })
        : func;

    // If this is a dynamic route then add a Vercel route
    const re = getRegExpFromPath(rePath);
    if (re) {
      routes.push({
        src: re.source,
        dest: path,
      });
    }
  }

  // Add a 404 path for not found pages to be server-side rendered by Remix.
  // Use an edge function bundle if one was generated, otherwise use Node.js.
  if (!output['404']) {
    const edgeFunctionIndex = Array.from(serverBundlesMap.values()).findIndex(
      routes => {
        const runtime = resolvedConfigsMap.get(routes[0])?.runtime;
        return runtime === 'edge';
      }
    );
    const func =
      edgeFunctionIndex !== -1 ? functions[edgeFunctionIndex] : functions[0];
    output['404'] =
      func instanceof EdgeFunction
        ? new EdgeFunction({ ...func, name: '404' })
        : func;
  }
  routes.push({
    src: '/(.*)',
    dest: '/404',
  });

  return { routes, output, framework: { version: remixVersion } };
};

function hasScript(scriptName: string, pkg: PackageJson | null) {
  const scripts = (pkg && pkg.scripts) || {};
  return typeof scripts[scriptName] === 'string';
}

async function createRenderNodeFunction(
  nodeVersion: NodeVersion,
  entrypointDir: string,
  rootDir: string,
  serverBuildPath: string,
  serverEntryPoint: string | undefined,
  remixVersion: string,
  config: ResolvedNodeRouteConfig
): Promise<NodejsLambda> {
  const files: Files = {};

  let handler = relative(rootDir, serverBuildPath);
  let handlerPath = join(rootDir, handler);
  if (!serverEntryPoint) {
    const baseServerBuildPath = basename(serverBuildPath, '.js');
    handler = join(dirname(handler), `server-${baseServerBuildPath}.mjs`);
    handlerPath = join(rootDir, handler);

    // Copy the `server-node.mjs` file into the "build" directory
    const nodeServerSrc = await nodeServerSrcPromise;
    await writeEntrypointFile(
      handlerPath,
      nodeServerSrc.replace(
        '@remix-run/dev/server-build',
        `./${baseServerBuildPath}.js`
      ),
      rootDir
    );
  }

  // Trace the handler with `@vercel/nft`
  const trace = await nodeFileTrace([handlerPath], {
    base: rootDir,
    processCwd: entrypointDir,
  });

  for (const warning of trace.warnings) {
    debug(`Warning from trace: ${warning.message}`);
  }

  for (const file of trace.fileList) {
    files[file] = await FileFsRef.fromFsPath({ fsPath: join(rootDir, file) });
  }

  const fn = new NodejsLambda({
    files,
    handler,
    runtime: nodeVersion.runtime,
    shouldAddHelpers: false,
    shouldAddSourcemapSupport: false,
    operationType: 'SSR',
    supportsResponseStreaming: true,
    regions: config.regions,
    memory: config.memory,
    maxDuration: config.maxDuration,
    framework: {
      slug: 'remix',
      version: remixVersion,
    },
  });

  return fn;
}

async function createRenderEdgeFunction(
  entrypointDir: string,
  rootDir: string,
  serverBuildPath: string,
  serverEntryPoint: string | undefined,
  remixVersion: string,
  config: ResolvedEdgeRouteConfig
): Promise<EdgeFunction> {
  const files: Files = {};

  let handler = relative(rootDir, serverBuildPath);
  let handlerPath = join(rootDir, handler);
  if (!serverEntryPoint) {
    const baseServerBuildPath = basename(serverBuildPath, '.js');
    handler = join(dirname(handler), `server-${baseServerBuildPath}.mjs`);
    handlerPath = join(rootDir, handler);

    // Copy the `server-edge.mjs` file into the "build" directory
    const edgeServerSrc = await edgeServerSrcPromise;
    await writeEntrypointFile(
      handlerPath,
      edgeServerSrc.replace(
        '@remix-run/dev/server-build',
        `./${baseServerBuildPath}.js`
      ),
      rootDir
    );
  }

  let remixRunVercelPkgJson: string | undefined;

  // Trace the handler with `@vercel/nft`
  const trace = await nodeFileTrace([handlerPath], {
    base: rootDir,
    processCwd: entrypointDir,
    conditions: ['edge-light', 'browser', 'module', 'import', 'require'],
    async readFile(fsPath) {
      let source: Buffer | string;
      try {
        source = await fs.readFile(fsPath);
      } catch (err: any) {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') {
          return null;
        }
        throw err;
      }
      if (basename(fsPath) === 'package.json') {
        // For Edge Functions, patch "main" field to prefer "browser" or "module"
        const pkgJson = JSON.parse(source.toString());

        // When `@remix-run/vercel` is detected, we need to modify the `package.json`
        // to include the "browser" field so that the proper Edge entrypoint file
        // is used. This is a temporary stop gap until this PR is merged:
        // https://github.com/remix-run/remix/pull/5537
        if (pkgJson.name === '@remix-run/vercel') {
          pkgJson.browser = 'dist/edge.js';
          pkgJson.dependencies['@remix-run/server-runtime'] =
            pkgJson.dependencies['@remix-run/node'];

          if (!remixRunVercelPkgJson) {
            remixRunVercelPkgJson = JSON.stringify(pkgJson, null, 2) + '\n';

            // Copy in the edge entrypoint so that NFT can properly resolve it
            const vercelEdgeEntrypointPath = join(
              DEFAULTS_PATH,
              'vercel-edge-entrypoint.js'
            );
            const vercelEdgeEntrypointDest = join(
              dirname(fsPath),
              'dist/edge.js'
            );
            await fs.copyFile(
              vercelEdgeEntrypointPath,
              vercelEdgeEntrypointDest
            );
          }
        }

        for (const prop of ['browser', 'module']) {
          const val = pkgJson[prop];
          if (typeof val === 'string') {
            pkgJson.main = val;

            // Return the modified `package.json` to nft
            source = JSON.stringify(pkgJson);
            break;
          }
        }
      }
      return source;
    },
  });

  for (const warning of trace.warnings) {
    debug(`Warning from trace: ${warning.message}`);
  }

  for (const file of trace.fileList) {
    if (
      remixRunVercelPkgJson &&
      file.endsWith(`@remix-run${sep}vercel${sep}package.json`)
    ) {
      // Use the modified `@remix-run/vercel` package.json which contains "browser" field
      files[file] = new FileBlob({ data: remixRunVercelPkgJson });
    } else {
      files[file] = await FileFsRef.fromFsPath({ fsPath: join(rootDir, file) });
    }
  }

  const fn = new EdgeFunction({
    files,
    deploymentTarget: 'v8-worker',
    name: 'render',
    entrypoint: handler,
    regions: config.regions,
    framework: {
      slug: 'remix',
      version: remixVersion,
    },
  });

  return fn;
}

async function writeEntrypointFile(
  path: string,
  data: string,
  rootDir: string
) {
  try {
    await fs.writeFile(path, data);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `The "${relative(
          rootDir,
          dirname(path)
        )}" directory does not exist. Please contact support at https://vercel.com/help.`
      );
    }
    throw err;
  }
}