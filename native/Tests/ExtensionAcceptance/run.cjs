'use strict';
// Actual application processes are launched only on a disposable Linux CI runner.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {pathToFileURL} = require('node:url');
const execute = promisify(execFile);
const REPOSITORY = path.resolve(__dirname, '../../..');
const NATIVE = path.join(REPOSITORY, 'native');
const HOST_NAME = 'com.redxai.gendragoon';
const FILE_LABEL = '<img src=x onerror=alert(1)> café 😀.txt';

function checksum(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
async function atomicJSON(file, value) {
  const temporary = file + '.new';
  await fs.writeFile(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  await fs.rename(temporary, file);
}
async function report(root, name, value) {
  await fs.writeFile(path.join(root, 'reports', name + '.json'), JSON.stringify({schema: 1, sourceCommit: process.env.GITHUB_SHA, ...value}, null, 2) + '\n', {mode: 0o600});
}
async function extract(python, archive, destination) {
  await execute(python, ['-B', '-c', `import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[2]);p.mkdir(mode=0o700)
with zipfile.ZipFile(sys.argv[1]) as z:
 if sum(i.file_size for i in z.infolist())>16*1024*1024:raise RuntimeError('Extension package exceeds fixture bound')
 for i in z.infolist():
  n=pathlib.PurePosixPath(i.filename)
  if n.is_absolute() or '..' in n.parts or ((i.external_attr>>16)&0o170000)==0o120000:raise RuntimeError('Unsafe extension archive')
 z.extractall(p)
`, archive, destination], {maxBuffer: 1024 * 1024});
}
async function startCompanion(root, origin, python) {
  const binary = process.env.GD_EXTENSION_NATIVE_HOST;
  assert.ok(binary && (await fs.readFile(binary)).subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'A real compiled ELF native host is mandatory');
  const child = spawn(python, ['-B', path.join(__dirname, 'companion_fixture.py'), '--root', root, '--host', binary, '--origin', origin], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, GD_EXTENSION_ACCEPTANCE_CI: '1', PYTHONDONTWRITEBYTECODE: '1'}
  });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  try { await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Disposable IPC fixture readiness timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Disposable fixture exited before readiness: ' + code + ' ' + errors)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4096) { clearTimeout(timer); reject(new Error('Oversized readiness response')); return; }
      if (output.includes('\n')) {
        try { assert.equal(JSON.parse(output.trim()).ready, true); clearTimeout(timer); resolve(); }
        catch (error) { clearTimeout(timer); reject(error); }
      }
    });
  }); } catch (error) { await stopChild(child); throw error; }
  return child;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function events(root) {
  return (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function chromiumTest(root, directory, archive, tools, python, client = 'chromium') {
  const {chromium} = tools('playwright');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const idInput = manifest.key ? Buffer.from(manifest.key, 'base64') : Buffer.from(await fs.realpath(directory));
  const identifier = checksum(idInput).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  const origin = 'chrome-extension://' + identifier + '/';
  const child = await startCompanion(root, origin, python);
  let context;
  try {
    let opera = null;
    if (client === 'opera') {
      const provenance = path.resolve(process.env.GD_EXTENSION_OPERA_PROVENANCE || '');
      const binary = path.resolve(process.env.GD_EXTENSION_OPERA_BINARY || '');
      const runnerRoot = await fs.realpath(process.env.RUNNER_TEMP);
      assert.ok(provenance.startsWith(runnerRoot + path.sep) && binary.startsWith(runnerRoot + path.sep));
      opera = JSON.parse(await fs.readFile(provenance, 'utf8'));
      assert.equal(opera.fixture, 'opera-stable');
      assert.equal(opera.packageSha256, '0ee45e6d17d2153860251e614ba09d6edca2fe2a32f40198a140896aaa3daf60');
      assert.equal(opera.binarySha256, checksum(await fs.readFile(binary)));
      assert.equal(opera.installerExecuted, false);
      assert.equal(opera.systemRegistrationChanged, false);
    }
    const vendorVersion = client === 'chromium' ? null : (await execute(client === 'opera' ? process.env.GD_EXTENSION_OPERA_BINARY : client === 'chrome' ? 'google-chrome' : 'microsoft-edge', ['--version'], {maxBuffer: 65536})).stdout.trim();
    if (vendorVersion) assert.match(vendorVersion, client === 'opera' ? /138\.0\.6044\.24/ : client === 'chrome' ? /^Google Chrome / : /^Microsoft Edge /);
    const profile = path.join(root, 'chromium-profile');
    const hosts = path.join(profile, 'NativeMessagingHosts');
    await fs.mkdir(hosts, {recursive: true, mode: 0o700});
    const binary = path.join(root, 'state/gendragoon/NativeMessaging/gendragoon-native-host');
    await fs.writeFile(path.join(hosts, HOST_NAME + '.json'), JSON.stringify({name: HOST_NAME, description: 'Disposable GenDragoon acceptance fixture', path: binary, type: 'stdio', allowed_origins: [origin]}), {mode: 0o600});
    const branded = client !== 'chromium';
    const cdpInstall = client === 'chrome' || client === 'edge';
    context = await chromium.launchPersistentContext(profile, {
      ...(client === 'opera' ? {executablePath: process.env.GD_EXTENSION_OPERA_BINARY} : {channel: client === 'edge' ? 'msedge' : client === 'chrome' ? 'chrome' : 'chromium'}), headless: !branded,
      // Stable Chrome/Edge removed --load-extension. Their experimental CDP
      // unpacked-install API is used only in this fresh account-free CI profile.
      // It does not establish signed store installation or normal user consent.
      ignoreDefaultArgs: branded ? ['--disable-extensions'] : [],
      args: cdpInstall ? ['--enable-unsafe-extension-debugging'] : ['--disable-extensions-except=' + directory, '--load-extension=' + directory],
      env: {...process.env, XDG_STATE_HOME: path.join(root, 'state'), PYTHONDONTWRITEBYTECODE: '1'}
    });
    await context.route(/^https?:/, route => route.abort());
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    const browserSession = await context.newCDPSession(page);
    const browserVersion = (await browserSession.send('Browser.getVersion')).product;
    await browserSession.detach();
    assert.ok(typeof browserVersion === 'string' && browserVersion.length > 0, 'Record the actual running Chromium version');
    if (cdpInstall) {
      const install = await context.browser().newBrowserCDPSession();
      try {
        const loaded = await install.send('Extensions.loadUnpacked', {path: directory});
        assert.equal(loaded.id, identifier, 'The actual brand-specific unpacked install must match the native allowlist');
      } finally { await install.detach(); }
    }
    await page.goto(origin + 'dashboard.html');
    assert.equal(await page.evaluate(() => chrome.runtime.id), identifier, 'The actual loaded extension identity must match the exact native-host allowlist');
    await page.locator('#status').filter({hasText: 'Approve this disposable CI fixture client first.'}).waitFor({timeout: 15000});
    assert.equal(await page.locator('#files li').count(), 0, 'Denied approval must not expose fixture metadata');
    await atomicJSON(path.join(root, 'consent.json'), {approved: true});
    await page.locator('#refresh').click();
    await page.locator('#status').filter({hasText: 'Connected as Disposable CI fixture.'}).waitFor({timeout: 15000});
    assert.equal(await page.locator('#notes option').count(), 2);
    assert.equal(await page.locator('#files li').textContent(), FILE_LABEL + ' · 17 archive bytes');
    assert.equal(await page.locator('#files img').count(), 0, 'Metadata must remain text, not executable HTML');
    assert.equal(await page.locator('#upload-file').isDisabled(), false);
    await page.locator('#notes').selectOption('b'.repeat(32));
    await page.locator('#note-detail').filter({hasText: 'Read only'}).waitFor();
    assert.equal(await page.locator('#upload-file').isDisabled(), true);
    assert.equal(await page.locator('#upload-folder').isDisabled(), true);
    await page.locator('#notes').selectOption('a'.repeat(32));
    await page.locator('#note-detail').filter({hasText: 'Ready for uploads.'}).waitFor();
    await page.locator('#upload-file').click();
    await page.locator('#status').filter({hasText: 'Selection cancelled.'}).waitFor();
    for (const [method, params] of [['request', {path: '/v1/integrations/keys', method: 'GET'}], ['uploadSelection', {workspaceId: 'a'.repeat(32), selectedPaths: ['/not-an-upload']}]] ) {
      const code = await page.evaluate(async ({method, params}) => { try { await GDCompanion.call(method, params); return null; } catch (error) { return error.code; } }, {method, params});
      assert.equal(code, 'route_denied');
    }
    const newPage = context.waitForEvent('page');
    await page.locator('#teams').click();
    const teams = await newPage;
    await teams.waitForLoadState('domcontentloaded');
    assert.equal(await teams.title(), 'GenDragoon Teams');
    assert.equal(await teams.locator('h1').textContent(), 'Build together.');
    await teams.close();
    await page.screenshot({path: path.join(root, 'reports/' + client + '-dashboard.png'), fullPage: true});
    await atomicJSON(path.join(root, 'consent.json'), {approved: false});
    const approvalRevoked = await page.evaluate(async () => { try { await GDCompanion.call('status'); return null; } catch (error) { return error.code; } });
    assert.equal(approvalRevoked, 'approval_required', 'Fixture consent removal must deny the already connected client');
    const traceBeforeOriginRemoval = await events(root);
    const configPath = path.join(root, 'state/gendragoon/NativeMessaging/config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.allowedOrigins = [];
    await atomicJSON(configPath, config);
    // Reload closes the real native port. A fresh host must reject its startup
    // caller; an uncorrelated startup error can surface as a disconnection.
    await page.reload();
    await page.locator('#status.error').waitFor({timeout: 15000});
    assert.equal(await page.locator('#files li').count(), 0, 'A denied new connection must not expose metadata');
    const trace = await events(root);
    assert.equal(trace.length, traceBeforeOriginRemoval.length, 'A denied new connection must never reach fixture dispatch');
    assert.ok(trace.some(event => event.clientId === origin && event.method === 'status'));
    assert.ok(trace.some(event => event.method === 'selectUpload'));
    assert.ok(!trace.some(event => event.method === 'uploadSelection' || event.path === '/v1/integrations/keys'));
    assert.deepEqual(errors, [], 'Unexpected real extension page errors');
    await report(root, client, {passed: true, browserVersion, vendorVersion, runnerImage: process.env.ImageVersion || null, operaFixture: opera, extensionVersion: manifest.version,
      extensionId: identifier, extensionArchiveSHA256: checksum(await fs.readFile(archive)), nativeHostSHA256: checksum(await fs.readFile(binary)),
      actualNativeMessaging: true, actualProductionPrivateIPC: true, approvalDeniedThenFixtureApproved: true,
      readOnlyControls: true, metadataRenderedAsText: true, disallowedRoutesRejected: true,
      fixtureApprovalRevokedOnExistingConnection: true, exactOriginRemovalDeniesNewConnection: true,
      teamsPageLoaded: true, syntheticAccountFreeDispatch: true, realNativeConsentUITested: false, liveAccountOrUploadTest: false,
      testedBrowser: client === 'chromium' ? 'Playwright bundled Chromium on Linux' : client === 'opera' ? 'Actual checksum-pinned official Opera extracted without installer on disposable Linux runner' : 'Actual installed stable ' + client + ' on disposable Linux runner',
      installationMethod: cdpInstall ? 'Experimental CDP Extensions.loadUnpacked in fresh CI profile' : 'Test-only --load-extension in fresh CI profile',
      signedStoreInstallationTested: false, normalUserApprovalTested: false, otherOperatingSystemsTested: false});
  } finally {
    try { if (context) await context.close(); }
    finally { await stopChild(child); }
  }
}

async function vscodeTest(root, directory, archive, tools, python) {
  const test = tools('@vscode/test-electron');
  const child = await startCompanion(root, 'chrome-extension://' + 'a'.repeat(32) + '/', python);
  try {
    await atomicJSON(path.join(root, 'consent.json'), {approved: true});
    const executable = await test.downloadAndUnzipVSCode({version: 'stable', cachePath: path.join(root, 'vscode-cache')});
    const [cli, ...cliArgs] = test.resolveCliArgsFromVSCodeExecutablePath(executable);
    const extensions = path.join(root, 'vscode-extensions'), profile = path.join(root, 'vscode-profile');
    await execute(cli, [...cliArgs, '--install-extension', archive, '--force', '--extensions-dir', extensions, '--user-data-dir', profile], {maxBuffer: 1024 * 1024});
    const installed = await execute(cli, [...cliArgs, '--list-extensions', '--show-versions', '--extensions-dir', extensions, '--user-data-dir', profile], {maxBuffer: 1024 * 1024});
    assert.match(installed.stdout, /^redxai\.gendragoon@0\./m, 'The actual generated VSIX must install into the disposable extension directory');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, {mode: 0o700});
    await test.runTests({vscodeExecutablePath: executable, cachePath: path.join(root, 'vscode-cache'), reuseMachineInstall: false, extensionDevelopmentPath: directory,
      extensionTestsPath: path.join(__dirname, 'vscode-suite.cjs'),
      launchArgs: [workspace, '--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
      extensionTestsEnv: {XDG_STATE_HOME: path.join(root, 'state'), GD_EXTENSION_ACCEPTANCE_ROOT: root, GITHUB_ACTIONS: 'true', PYTHONDONTWRITEBYTECODE: '1'}
    });
    const result = JSON.parse(await fs.readFile(path.join(root, 'reports/vscode.json'), 'utf8'));
    assert.equal(result.passed, true);
    await report(root, 'vscode', {...result, actualVSIXInstalled: true, extensionArchiveSHA256: checksum(await fs.readFile(archive)), nativeHostSHA256: checksum(await fs.readFile(process.env.GD_EXTENSION_NATIVE_HOST))});
  } finally { await stopChild(child); }
}

async function firefoxTest(root, directory, archive, tools) {
  const packageRoot = path.join(process.env.GD_EXTENSION_TEST_TOOLS, 'node_modules/web-ext');
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const cli = path.resolve(packageRoot, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin['web-ext']);
  const lint = await execute(process.execPath, [cli, 'lint', '--source-dir', directory, '--output=json'], {maxBuffer: 2 * 1024 * 1024});
  const result = JSON.parse(lint.stdout);
  assert.equal(result.summary?.errors ?? result.errors?.length, 0, 'Actual web-ext lint must have zero errors');
  await fs.writeFile(path.join(root, 'reports/firefox-lint.json'), JSON.stringify(result, null, 2) + '\n');
  const imported = await import(pathToFileURL(tools.resolve('web-ext')).href);
  const webExt = imported.default;
  const firefox = tools('playwright').firefox;
  const browserVersion = (await execute(firefox.executablePath(), ['--version'], {maxBuffer: 65536})).stdout.trim();
  assert.ok(browserVersion.length > 0, 'Record the actual isolated Firefox version');
  let runner;
  try {
    runner = await webExt.cmd.run({sourceDir: directory, firefox: firefox.executablePath(), noReload: true, noInput: true, startUrl: ['about:blank'], args: ['-headless']}, {shouldExitProgram: false});
    await runner.reloadAllExtensions();
    await report(root, 'firefox', {passed: true, webExtVersion: metadata.version, browserVersion,
      extensionArchiveSHA256: checksum(await fs.readFile(archive)), realFirefoxTemporaryLoadAndReload: true, lintErrors: 0,
      nativeMessagingTested: false, liveAccountOrUploadTest: false, signedStoreInstallationTested: false});
  } finally { if (runner) await runner.exit(); }
}

async function main() {
  const client = process.argv[2];
  if (client === '--help') { console.log('usage: node run.cjs chromium|chrome|edge|opera|vscode|firefox\nRuns only inside the dedicated disposable Linux CI workflow.'); return; }
  assert.ok(['chromium', 'chrome', 'edge', 'opera', 'vscode', 'firefox'].includes(client));
  assert.equal(process.platform, 'linux', 'Never launch these tests in a user desktop session');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const root = path.resolve(process.env.GD_EXTENSION_ACCEPTANCE_ROOT || '');
  const runner = await fs.realpath(process.env.RUNNER_TEMP);
  assert.ok(root.startsWith(runner + path.sep) && root !== runner);
  await fs.mkdir(root, {mode: 0o700});
  await fs.mkdir(path.join(root, 'reports'), {mode: 0o700});
  const tools = createRequire(path.join(process.env.GD_EXTENSION_TEST_TOOLS, 'package.json'));
  const python = process.env.GD_EXTENSION_PYTHON;
  assert.ok(python && path.isAbsolute(python));
  await execute(python, ['-B', path.join(NATIVE, 'Extensions/package_extensions.py'), '--output', path.join(root, 'packages')], {maxBuffer: 1024 * 1024});
  const names = await fs.readdir(path.join(root, 'packages'));
  const matching = names.filter(name => client === 'vscode' ? name.endsWith('.vsix') : name.startsWith('gendragoon-' + (client === 'chromium' ? 'chrome' : client) + '-') && name.endsWith('.zip'));
  assert.equal(matching.length, 1);
  const archive = path.join(root, 'packages', matching[0]);
  const directory = path.join(root, 'unpacked');
  await extract(python, archive, directory);
  if (['chromium', 'chrome', 'edge', 'opera'].includes(client)) await chromiumTest(root, directory, archive, tools, python, client);
  else if (client === 'vscode') await vscodeTest(root, path.join(directory, 'extension'), archive, tools, python);
  else await firefoxTest(root, directory, archive, tools);
  console.log(JSON.stringify({client, passed: true, syntheticFixtureOnly: true}));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
