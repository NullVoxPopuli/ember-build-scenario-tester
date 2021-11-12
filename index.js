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

const TERSER = 'ember-cli-terser';
const ESBUILD = 'ember-cli-esbuild-minifier';
const SWC = 'ember-cli-swc-minifier'; // pending

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
    name: 'Terser w/ no sequences/semicolons',
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
];

async function run() {
  let depManager = await detectDependencyManager();
  let results = {};

  await ensureClassicBuild();

  for (let scenario of SCENARIOS) {
    announce(`Scenario: ${scenario.name}`);

    try {
      await removeMinifiers();
      await addDependency(scenario.minifier);
      await applyConfig(scenario.appConfig);
      await installDependencies(depManager);

      let time = await productionBuild();

      await runCompressors();

      let sizes = await measureSizes();

      results[scenario.name] = {
        time,
        sizes,
      };
    } finally {
      await cleanConfig(scenario.appConfig);
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

function displayResults(results) {
  for (let result of Object.values(results)) {
    result.time = prettyMs(result.time);

    for (let [filePath, size] of Object.entries(result.sizes)) {
      let shortPath = filePath.split('dist/assets/')[1];
      let ext = path.extname(shortPath);
      // app/vendor use -
      // chunks use .
      let shortName = shortPath.split('-')[0] + ' ' + ext;
      let parts = shortName.split('.');

      shortName = parts[0] + parts[1] || '';

      result[shortName] = filesize(size, { round: 2 });
    }

    delete result.sizes;
  }

  console.table(results);
}

/**
 * @returns {Promise<'npm' | 'yarn'>}
 */
async function detectDependencyManager() {
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
  await removeDependencies(SCENARIOS.map((scenario) => scenario.minifier));
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
}

async function productionBuild() {
  info(`Running ember build --environment production`);

  let startTime = new Date().getTime();

  await execa('ember', ['build', '--environment', 'production'], { cwd: CWD });

  let endTime = new Date().getTime();
  let ms = endTime - startTime;

  return ms;
}

async function runCompressors() {
  info(`Running gzip and brotli`);

  await gzip({
    patterns: [`${CWD}/dist/assets/*.{js}`],
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
  await fs.writeFile(path.join(CWD, 'package.json'), JSON.stringify(json));
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
