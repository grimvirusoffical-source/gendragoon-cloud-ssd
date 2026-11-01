'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const root = process.env.GD_EXTENSION_ACCEPTANCE_ROOT;
  assert.ok(root && process.env.GITHUB_ACTIONS === 'true');
  const extension = vscode.extensions.getExtension('redxai.gendragoon');
  assert.ok(extension, 'The actual packaged extension must be discovered by VS Code');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = ['gendragoon.status', 'gendragoon.machineNotes', 'gendragoon.uploadFiles', 'gendragoon.uploadFolder', 'gendragoon.teams'];
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const command of commands) assert.ok(registered.has(command), 'Missing real command: ' + command);
  assert.deepEqual(extension.packageJSON.capabilities.untrustedWorkspaces, {supported: false});
  assert.deepEqual(extension.packageJSON.capabilities.virtualWorkspaces, {supported: false});
  await vscode.commands.executeCommand('gendragoon.status');
  const events = (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some(event => event.method === 'status' && event.clientKind === 'vscode' && event.clientId === 'redxai.gendragoon'), 'Status must cross the actual ELF native host and production private IPC server');
  // The command intentionally catches UI errors. Also require its exact packaged
  // transport to return a verified response, rather than accepting a trace alone.
  const {NativeClient} = require(path.join(extension.extensionPath, 'vscode/native-client.cjs'));
  const probe = new NativeClient();
  try {
    const status = await probe.call('status');
    assert.equal(status.connected, true);
    assert.equal(status.accountLabel, 'Disposable CI fixture');
  } finally { probe.close(); }
  await fs.writeFile(path.join(root, 'reports/vscode.json'), JSON.stringify({
    schema: 1, passed: true, editorVersion: vscode.version, extensionVersion: extension.packageJSON.version,
    actualExtensionHostActivation: true, registeredCommands: commands, actualELFHostAndPrivateIPC: true, verifiedStatusResponse: true,
    syntheticAccountFreeDispatch: true, liveAccountOrUploadTest: false, realNativeConsentUITested: false,
    trustedWorkspaceOnly: true
  }, null, 2) + '\n');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
};
