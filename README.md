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
