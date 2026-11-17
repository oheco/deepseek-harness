/** Regenerates the input callback snapshot with the installed API-26 SDK and Hvigor. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const tests = dirname(fileURLToPath(import.meta.url));
const app = resolve(tests, '..');
const fixtureDirectory = join(tests, 'fixtures');
const sdk = process.env.OHOS_SDK_HOME ?? process.env.OHOS_BASE_SDK_HOME;
if (!sdk || !process.env.TMPDIR) throw new Error('Set OHOS_SDK_HOME to the API-26 SDK and provide TMPDIR');
const sdkMetadata = JSON.parse(readFileSync(join(sdk, '26.0.0/ets/oh-uni-package.json'), 'utf8'));
if (Number(sdkMetadata.apiVersion) !== 26) throw new Error('The input fixture requires an actual API-26 SDK');
const previousUmask = process.umask(0o077);
const temporary = mkdtempSync(join(process.env.TMPDIR, 'dsh-field-sdk-fixture-'));
const project = join(temporary, 'project');
const digest = value => createHash('sha256').update(value).digest('hex');
function save(relative, contents) {
  const path = join(project, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}
try {
  mkdirSync(project, { mode: 0o700 });
  cpSync(join(app, 'AppScope'), join(project, 'AppScope'), { recursive: true });
  cpSync(join(app, 'entry/src/main/resources'), join(project, 'entry/src/main/resources'), { recursive: true });
  const input = readFileSync(join(app, 'entry/src/main/ets/pages/ConnectionField.ets'), 'utf8');
  save('entry/src/main/ets/pages/ConnectionField.ets', input);
  save('entry/src/main/ets/pages/Index.ets', `import { ConnectionField } from './ConnectionField';
@Entry
@Component
struct Index {
  @State token: string = '';
  @State busy: boolean = false;
  build() {
    Column() {
      ConnectionField({ label: $r('app.string.dsh_token'), value: this.token, secret: true, locked: this.busy })
    }
  }
}
`);
  save('entry/src/main/ets/entryability/EntryAbility.ets', `import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
export default class EntryAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/Index'); }
}
`);
  save('build-profile.json5', JSON.stringify({ app: {
    signingConfigs: [], products: [{ name: 'default', compileSdkVersion: '26.0.0', targetSdkVersion: '26.0.0', compatibleSdkVersion: 23,
      runtimeOS: 'OpenHarmony', buildOption: { strictMode: { caseSensitiveCheck: true, useNormalizedOHMUrl: true } } }],
    buildModeSet: [{ name: 'debug' }]
  }, modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }] }, null, 2));
  save('entry/build-profile.json5', JSON.stringify({ apiType: 'stageMode', targets: [{ name: 'default' }] }));
  save('entry/src/main/module.json5', JSON.stringify({ module: {
    name: 'entry', type: 'entry', mainElement: 'EntryAbility', deviceTypes: ['2in1'], deliveryWithInstall: true,
    installationFree: false, pages: '$profile:main_pages', abilities: [{ name: 'EntryAbility', srcEntry: './ets/entryability/EntryAbility.ets',
      startWindowIcon: '$media:ability_icon', startWindowBackground: '$color:start_window_background', exported: true, launchType: 'singleton' }]
  } }));
  save('oh-package.json5', JSON.stringify({ modelVersion: '6.0.0', name: 'dsh-field-sdk-fixture', version: '1.0.0', dependencies: {}, devDependencies: {} }));
  save('entry/oh-package.json5', JSON.stringify({ name: 'entry', version: '1.0.0', dependencies: {} }));
  save('hvigorfile.ts', "import { appTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: appTasks, plugins: [] };\n");
  save('entry/hvigorfile.ts', "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n");
  save('hvigor/hvigor-config.json5', JSON.stringify({ modelVersion: '6.0.0', dependencies: {}, execution: { daemon: false, parallel: false } }));
  const args = ['--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon', '--stacktrace'];
  const child = spawn(process.env.HVIGOR_BIN ?? 'hvigor', args, { cwd: project,
    env: { ...process.env, OHOS_SDK_HOME: sdk, OHOS_BASE_SDK_HOME: sdk, HVIGOR_USER_HOME: join(temporary, 'hvigor-user-home') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
  const code = await new Promise((done, fail) => { child.on('error', fail); child.on('close', done); });
  if (code !== 0) throw new Error('SDK fixture compilation failed with exit ' + code);
  const generated = new Map();
  function locate(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) locate(path);
      else if (['ConnectionField.ts', 'Index.ts'].includes(entry.name) && path.includes('CompileArkTS')) generated.set(entry.name, path);
    }
  }
  locate(join(project, 'entry/build'));
  if (generated.size !== 2) throw new Error('Expected SDK-generated input and host components');
  const sdkField = readFileSync(generated.get('ConnectionField.ts'), 'utf8');
  const sdkHost = readFileSync(generated.get('Index.ts'), 'utf8');
  if (!sdkHost.includes('value: this.__token')) throw new Error('SDK did not wire the child Link to the parent observed token');
  if (digest(readFileSync(join(app, 'entry/src/main/ets/pages/ConnectionField.ets'))) !== digest(input)) throw new Error('Input source changed during compilation');
  const fixture = ts.transpileModule(sdkField, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const metadata = { source: 'entry/src/main/ets/pages/ConnectionField.ets', sourceSha256: digest(input),
    sdkPackageVersion: sdkMetadata.version + '-' + sdkMetadata.releaseType, apiVersion: Number(sdkMetadata.apiVersion),
    sdkGeneratedTypeScriptSha256: digest(sdkField), fixtureSha256: digest(fixture),
    postprocess: 'TypeScript transpileModule ES2022/ESNext removes type annotations from SDK-generated code',
    parentLinkWiring: 'value: this.__token', compileExitCode: code,
    regenerationCommand: 'OHOS_SDK_HOME=<API-26 SDK root> node ohos/app/tests/regenerate-connection-field-fixture.mjs',
    compileTask: args, noSigningOrDeviceActions: true };
  // Source snapshots are public workspace files; keep the private umask scoped to temporary build storage.
  process.umask(previousUmask);
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(join(fixtureDirectory, 'connection-field.sdk.js'), fixture);
  writeFileSync(join(fixtureDirectory, 'connection-field.sdk.json'), JSON.stringify(metadata, null, 2) + '\n');
  const validation = join(app, 'validation/connection-fix1');
  mkdirSync(validation, { recursive: true });
  writeFileSync(join(validation, 'ui-reactivity-compile.log'), log);
  writeFileSync(join(validation, 'ui-reactivity-compile.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ regenerated: true, sourceSha256: metadata.sourceSha256, parentLinkWiring: metadata.parentLinkWiring }));
} finally {
  process.umask(previousUmask);
  rmSync(temporary, { recursive: true, force: true });
}
