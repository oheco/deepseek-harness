/** Standalone semantic check with an explicit installed SDK; not an assembleHap build. */
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {values} = parseArgs({options: {sdk: {type: 'string'}, output: {type: 'string'}}});
if (!values.sdk || !values.output) throw new Error('Pass --sdk and a new private --output directory');
const sdk = path.resolve(values.sdk);
const app = path.resolve(__dirname, 'app');
const root = path.join(app, 'entry/src/main/ets');
const output = path.resolve(values.output);
fs.mkdirSync(output, {mode: 0o700});
const product = JSON.parse(fs.readFileSync(path.join(app, 'build-profile.json5'), 'utf8')).app.products[0];
const bundle = JSON.parse(fs.readFileSync(path.join(app, 'AppScope/app.json5'), 'utf8')).app.bundleName;
const api = value => Number(/^.*\((\d+)\)$/.exec(value)?.[1]);
for (const name of ['compileSdkVersion', 'targetSdkVersion', 'compatibleSdkVersion']) {
  if (!Number.isInteger(api(product[name]))) throw new Error(`Invalid product SDK field: ${name}`);
}
const checker = require(path.join(sdk, 'build-tools/ets-loader/lib/ets_checker.js'));
require(path.join(sdk, 'build-tools/ets-loader/main.js'));
const entries = {};
for (const [name, relative] of Object.entries({EntryAbility: 'entryability/EntryAbility.ets', Index: 'pages/Index.ets',
  ServiceProbe: 'launcher/ServiceProbe.ets', RunLogWatcher: 'launcher/RunLogWatcher.ets',
  RunLogUrl: 'launcher/RunLogUrl.ets', Defaults: 'config/RuntimeDefaults.ets'})) entries[name] = path.join(root, relative);
const config = {
  projectPath: root, projectTopDir: app, aceModuleRoot: app + '/entry',
  aceModuleJsonPath: app + '/entry/src/main/module.json5', modulePath: app + '/entry', moduleName: 'entry',
  bundleName: bundle, compileMode: 'esmodule', compileSdkVersion: api(product.compileSdkVersion),
  compatibleSdkVersion: api(product.compatibleSdkVersion), compatibleSdkVersionStage: 'beta',
  minAPIVersion: api(product.compatibleSdkVersion), targetAPIVersion: api(product.targetSdkVersion),
  sdkPath: sdk, etsLoaderPath: sdk + '/build-tools/ets-loader', cachePath: output + '/cache', buildPath: output + '/build',
  buildMode: 'debug', packageManagerType: 'ohpm', runtimeOS: 'HarmonyOS', deviceTypes: ['2in1'],
  isPreview: false, projectArkOption: {}, resolveModulePaths: [app + '/entry/src/main/cpp/types']
};
fs.mkdirSync(config.cachePath); fs.mkdirSync(config.buildPath);
checker.compilerOptions.paths = {'libdsh_launcher.so': [app + '/entry/src/main/cpp/types/libdsh_launcher/index.d.ts']};
// The checker's own counter stays zero on semantic errors, so the logger is the
// authority for this check's exit status.
let errors = 0;
checker.etsStandaloneChecker(entries, {
  error(...args) { errors += 1; console.error(...args); },
  warn: console.warn, info: console.info, debug() {}
}, config);
console.log('Configured product SDK:', product.compileSdkVersion);
console.log('Checker installation:', sdk);
console.log('checkerResult:', checker.checkerResult, 'errors reported:', errors);
if (errors !== 0) process.exitCode = 1;
