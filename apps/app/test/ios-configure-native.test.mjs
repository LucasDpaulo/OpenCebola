import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '../../../scripts/ios-configure-native.mjs');
for (const [input, expected] of [['.v15', '"16.1"'], ['.v16', '"16.1"'], ['"16.0"', '"16.1"'], ['"16.1"', '"16.1"'], ['.v17', '.v17']]) {
  test(`sync iOS mantém mínimo compatível ao receber ${input}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cebola-ios-sync-'));
    const app = path.join(root, 'apps/app/ios/App');
    try {
      for (const dir of ['scripts', 'apps/app/ios/App/CapApp-SPM', 'apps/app/ios/App/App.xcodeproj', 'apps/app/ios/App/App/Base.lproj']) mkdirSync(path.join(root, dir), { recursive: true });
      const executable = path.join(root, 'scripts/ios-configure-native.mjs');
      copyFileSync(script, executable);
      const manifest = path.join(app, 'CapApp-SPM/Package.swift');
      writeFileSync(manifest, `platforms: [.iOS(${input})],\n    dependencies: [\n    ],\n            dependencies: [\n            ]\n`);
      writeFileSync(path.join(app, 'App.xcodeproj/project.pbxproj'), 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
      writeFileSync(path.join(app, 'App/Base.lproj/Main.storyboard'), 'customClass="CAPBridgeViewController" customModule="Capacitor"');
      writeFileSync(path.join(app, 'App/Info.plist'), '<plist><dict></dict></plist>');
      execFileSync(process.execPath, [executable]);
      const first = readFileSync(manifest, 'utf8');
      assert.ok(first.includes(`platforms: [.iOS(${expected})]`));
      assert.equal(readFileSync(path.join(app, 'App.xcodeproj/project.pbxproj'), 'utf8'), 'IPHONEOS_DEPLOYMENT_TARGET = 16.1;');
      execFileSync(process.execPath, [executable]);
      assert.equal(readFileSync(manifest, 'utf8'), first);
      assert.equal((first.match(/\.package\(path: "\.\.\/\.\.\/native"\)/g) ?? []).length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
