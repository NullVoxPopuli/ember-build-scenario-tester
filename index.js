/* eslint-disable no-console */
//@ts-check

/**
 * Invoke this script via
 *
 * node ./index.js
 *
 * It takes no arguments and is not configurable.
 * To change scenarios, edit the file.
 *
 *
 */

import fs from 'fs/promises';
import path from 'path';
import fse from 'fs-extra';
import jscodeshift from 'jscodeshift';
import execa from 'execa';
import { gzip } from 'gzip-cli';
import { globby } from 'globby';
import chalk from 'chalk';
import filesize from 'filesize';
import prettyMs from 'pretty-ms';

const SETTINGS = {
  /**
   * Sometimes there are too many for console output
   *
   * @type {boolean}
   */
  hideChunks: true,

  /**
   * detection dep manager in monorepo workspace is not implemented
   *
   * @type {'npm' | 'yarn'}
   */
  forceDepManager: 'yarn',

  /**
   * Customize the ENV for the build tasks
   */
  env: {
    // JOBS: 1,
  },
};

const TERSER = 'ember-cli-terser';
const ESBUILD = 'ember-cli-esbuild-minifier';
const SWC = 'ember-cli-swc-minifier';

const CWD = process.cwd();
const appBuildFile = path.join(CWD, 'ember-cli-build.js');

const SCENARIOS = [
  {
    name: 'Default Terser',
    minifier: TERSER,
    appConfig: {
      'ember-cli-terser': {},
    },
  },
  {
    name: 'Terser w/ sequences/semicolons',
    minifier: TERSER,
    appConfig: {
      'ember-cli-terser': {
        terser: {
          compress: {
            sequences: false,
          },
          output: {
            semicolons: false,
          },
        },
      },
    },
  },
  {
    name: 'Default ESBuild',
    minifier: ESBUILD,
    appConfig: {},
  },
  {
    name: 'Default SWC',
    minifier: SWC,
    appConfig: {},
  },
];

/**
 * @typedef {Record<string, number>} SizeInfo;
 *
 * @typedef {Object} Result;
 * @property {number} time;
 * @property {SizeInfo} sizes;
 *
 * @typedef {Record<string, Result>} Results;
 *
 *
 */

async function run() {
  let depManager = await detectDependencyManager();
  /* @type {Results} */
  let results = {};

  // await ensureClassicBuild();

  for (let jobs of [1, 3, 7]) {
    for (let scenario of SCENARIOS) {
      let name = `JOBS=${jobs} :: ${scenario.name}`;

      announce(`Scenario: ${name}`);

      try {
        SETTINGS.env.JOBS = jobs;

        await removeMinifiers();
        await removeDist();
        await addDependency(scenario.minifier);
        await applyConfig(scenario.appConfig);
        await installDependencies(depManager);
        await printVersion(depManager, scenario.minifier);

        let time = await productionBuild();

        await runCompressors();

        let sizes = await measureSizes();

        results[name] = {
          time,
          sizes,
        };
      } catch (e) {
        error(`${name} errored with ${e.message}`);
        console.error(e);
      } finally {
        await cleanConfig(scenario.appConfig);
      }
    }
  }

  displayResults(results);
}

await run();

/*
 *
 *  Helpers and stuff below
 *
 */

function twoDecimals(num) {
  return Math.round(num * 100) / 100;
}

function deltaPercent(min, current) {
  let diff = twoDecimals((current / min - 1) * 100);

  return `${diff < 0 ? '' : '+'}${diff}%`;
}

/**
 * @param {Array<Result>} collection
 * @param {(result: Result) => number} selector
 *
 * @returns {number}
 */
function minOf(collection, selector) {
  return Math.min(...collection.map(selector));
}

/**
 * @param {string} filePath
 */
function assertShortName(filePath) {
  let shortPath = filePath.split('dist/assets/')[1];
  let extParts = shortPath.split('.');
  let ext = '';

  for (let extPart of extParts) {
    if (extPart.length <= 2) {
      ext += `.${extPart}`;
    }
  }

  // app/vendor use -
  // chunks use .
  let shortName = shortPath.split('-')[0];
  let parts = shortName.split('.');

  shortName = parts[0] + (parts[1] || '');

  return { shortName, ext, withExt: `${shortName}${ext}` };
}

/**
 * Shows deltas for time and asset sizes.
 * Formats the results object to work with console.table.
 *
 * @param {Results} results
 */
function displayResults(results) {
  let values = Object.values(results);
  let minTime = Math.min(...values.map((result) => result.time));

  for (let result of values) {
    result[`Δt`] = deltaPercent(minTime, result.time);
    result.time = prettyMs(result.time);

    for (let [filePath, size] of Object.entries(result.sizes)) {
      if (filePath.includes('.txt')) continue;

      if (SETTINGS.hideChunks) {
        if (filePath.includes('chunk')) continue;
        if (filePath.includes('assets-fingerprint')) continue;
      }

      let { shortName, ext, withExt } = assertShortName(filePath);
      let minSize = minOf(values, (result) => {
        // the hash / fingerprint changes between minifiers
        let key = Object.keys(result.sizes).find(
          (fullPath) => assertShortName(fullPath).withExt === withExt
        );

        return result.sizes[key];
      });

      result[withExt] = filesize(size, { round: 2 });
      result[`${shortName} Δ${ext}`] = deltaPercent(minSize, size);
    }
  }

  // Delete the sizes collection, because it won't render well in the table
  values.forEach((result) => delete result.sizes);

  console.table(results);
}

/**
 * @returns {Promise<'npm' | 'yarn'>}
 */
async function detectDependencyManager() {
  if (SETTINGS.forceDepManager) {
    return SETTINGS.forceDepManager;
  }

  let [hasYarnLock, hasPackageLock] = await Promise.all([
    fse.pathExists(path.join(CWD, 'yarn.lock')),
    fse.pathExists(path.join(CWD, 'package-lock.json')),
  ]);

  if (hasYarnLock) {
    return 'yarn';
  }

  if (hasPackageLock) {
    return 'npm';
  }

  throw new Error('Could not determine dependency manager or dependency manager is not supported');
}

async function removeDist() {
  await fse.remove(path.join(CWD, 'dist'));
}

/**
 * If embroider is present, an early return app.toTree()
 * is added.
 * This is primitive, but it helps for simple cases.
 */
async function ensureClassicBuild() {
  let file = await readBuildFile();
  let j = jscodeshift.withParser('babel');

  let isClassic = false;
  let ast = j(file);

  ast
    .find(j.ReturnStatement, {
      argument: { callee: { object: { name: 'app' }, property: { name: 'toTree' } } },
    })
    .forEach(() => {
      isClassic = true;
    });

  if (!isClassic) {
    ast.find(j.ReturnStatement).forEach((path) => {
      let classicBuild = j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('toTree')),
        []
      );

      j(path).insertBefore(j.returnStatement(classicBuild));
    });
  }

  let transformed = ast.toSource();

  await writeBuildFile(transformed);
}

async function removeMinifiers() {
  await removeDependencies([
    '@nullvoxpopuli/ember-cli-esbuild',
    ...SCENARIOS.map((scenario) => scenario.minifier),
  ]);
}

async function printVersion(depManager, depName) {
  let command = '';

  switch (depManager) {
    case 'npm':
      command = 'list';

      break;
    case 'yarn':
      command = 'list';

      break;
    default:
      throw new Error(`${depManager} not supported`);
  }

  let { stdout } = await execa(depManager, [command, depName], { cwd: CWD });

  let lines = stdout.split('\n').reverse();

  for (let line of lines) {
    if (line.includes(depName)) {
      let match = line.match(new RegExp(`(${depName}@[^ ]+)`))[1];

      if (match) {
        info(`Using ${match}`);

        return;
      }
    }
  }
}

/**
 * @param {string} depName
 */
async function addDependency(depName) {
  let json = await readPackageJson();

  json.devDependencies[depName] = '*';

  await writePackageJson(json);
}

async function applyConfig(config) {
  let file = await readBuildFile();
  let j = jscodeshift.withParser('babel');

  let ast = j(file);

  for (let [key, value] of Object.entries(config)) {
    ast.find(j.NewExpression, { callee: { name: 'EmberApp' } }).forEach((path) => {
      j(path)
        .find(j.Property, { key: { value: key } })
        .forEach((objPath) => {
          j(objPath).replaceWith(j.identifier(`'${key}': ${JSON.stringify(value)}`));
        });
    });
  }

  let transformed = ast.toSource();

  await writeBuildFile(transformed);
}

async function cleanConfig(config) {
  let file = await readBuildFile();
  let j = jscodeshift.withParser('babel');

  let ast = j(file);

  for (let [key] of Object.entries(config)) {
    let value = {};

    ast.find(j.NewExpression, { callee: { name: 'EmberApp' } }).forEach((path) => {
      j(path)
        .find(j.Property, { key: { value: key } })
        .forEach((objPath) => {
          j(objPath).replaceWith(j.identifier(`'${key}': ${JSON.stringify(value)}`));
        });
    });
  }

  let transformed = ast.toSource();

  await writeBuildFile(transformed);
}

/**
 * @param {'npm' | 'yarn'} depManager
 */
async function installDependencies(depManager) {
  info(`Installing deps with ${depManager}`);

  await execa(depManager, ['install'], { cwd: CWD });

  // Booooooo
  if (await hasDependency('node-sass')) {
    info('Rebuilding node-sass....');
    await execa(`npm`, ['rebuild', 'node-sass'], { cwd: CWD });
  }
}

async function productionBuild() {
  info(`Running ember build --environment production`);

  let startTime = new Date().getTime();

  await execa('ember', ['build', '--environment', 'production'], { cwd: CWD, env: SETTINGS.env });

  let endTime = new Date().getTime();
  let ms = endTime - startTime;

  return ms;
}

async function runCompressors() {
  info(`Running gzip and brotli`);

  await gzip({
    patterns: [`${CWD}/dist/assets/*.js*`],
    outputExtensions: ['gz', 'br'],
  });
}

async function measureSizes() {
  let jsFiles = await globby([path.join(CWD, 'dist', 'assets', '*.js*')]);
  let results = {};

  for (let jsFile of jsFiles) {
    let stat = await fs.stat(jsFile);

    results[jsFile] = stat.size;
  }

  return results;
}

/**
 *
 * Low level helpers?
 *
 */

async function hasDependency(depName) {
  let json = await readPackageJson();

  let deps = {
    ...json['dependencies'],
    ...json['devDependencies'],
  };

  return Boolean(deps[depName]);
}

/**
 * @param {string[]} dependencyList
 */
async function removeDependencies(dependencyList) {
  let json = await readPackageJson();

  let filterDeps = (specifiedDeps) =>
    Object.entries(specifiedDeps).reduce((deps, [depName, version]) => {
      if (dependencyList.includes(depName)) {
        return deps;
      }

      deps[depName] = version;

      return deps;
    }, {});

  if (json.dependencies) {
    json.dependencies = filterDeps(json.dependencies);
  }

  if (json.devDependencies) {
    json.devDependencies = filterDeps(json.devDependencies);
  }

  await writePackageJson(json);
}

async function readPackageJson() {
  let buffer = await fs.readFile(path.join(CWD, 'package.json'));

  return JSON.parse(buffer.toString());
}

async function writePackageJson(json) {
  await fs.writeFile(path.join(CWD, 'package.json'), JSON.stringify(json, null, 2));
}

async function readBuildFile() {
  let buffer = await fs.readFile(appBuildFile);

  return buffer.toString();
}

async function writeBuildFile(data) {
  await fs.writeFile(appBuildFile, data);
}

function announce(text) {
  console.log(chalk.yellowBright(text));
}

function info(text) {
  console.info(chalk.dim(text));
}

function error(text) {
  console.error(chalk.redBright(text));
}
