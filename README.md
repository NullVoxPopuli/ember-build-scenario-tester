# ember-build-scenario-tester

This tool does the following

- detects yarn/npm
- tweaks `ember-cli-build.js` to be a classic build (non-embroider)

_for each scenario_:
- removes minifiers from package.json
- adds minifier for scenario (if specified)
- tweaks `ember-cli-build.js` with config for the scenario
- install dependencies
- runs `ember build --environment=production`
  - records time
  - records sizes
    - and w/ gzip
    - and w/ brotly
- outputs stats in an easy to read format

## Usage

1. clone the repo
2. cd to the repo
3. run `npm install`
4. cd to the project you want to test
5. run `node ../../(etc)/<clone-location>/index.js`
