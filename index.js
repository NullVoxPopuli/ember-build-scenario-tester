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

  await ensureClassicBuild();

  for (let scenario of SCENARIOS) {
    await removeMinifiers();
    await addDependency(scenario.minifier);
    await applyConfig(scenario.appConfig);
    await installDependencies(depManager);

    let time = await productionBuild();

    await runGzip();
    await runBrotli();

    let sizes = await measureSizes();

    console.log({ time, sizes });
  }
}

await run();

/*
 *
 *  Helpers and stuff below
 *
 */

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
async function ensureClassicBuild() {}

async function removeMinifiers() {}

/**
 * @param {string} depName
 */
async function addDependency(depName) {}

async function applyConfig(config) {}

/**
 * @param {'npm' | 'yarn'} depManager
 */
async function installDependencies(depManager) {}

async function productionBuild() {}

async function runGzip() {}

async function runBrotli() {}

async function measureSizes() {}
