import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'apps/app/ios/App');
const generated = path.join(app, 'CapApp-SPM/Package.swift');
let source = fs.readFileSync(generated, 'utf8').replace(/platforms:\s*\[\.iOS\(([^)]+)\)\]/, (original, version) => {
  const parts = version.replace(/^\.v/, '').replaceAll('"', '').replaceAll('_', '.').split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1] ?? 0);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) throw new Error('Versão iOS gerada não reconhecida.');
  return major < 16 || (major === 16 && minor < 1) ? 'platforms: [.iOS("16.1")]' : original;
});
if (!source.includes('.package(path: "../../native")')) {
  source = source.replace('    dependencies: [', '    dependencies: [\n        .package(path: "../../native"),');
  source = source.replace('            dependencies: [', '            dependencies: [\n                .product(name: "CebolaNative", package: "native"),');
}
fs.writeFileSync(generated, source);
const project = path.join(app, 'App.xcodeproj/project.pbxproj');
fs.writeFileSync(project, fs.readFileSync(project, 'utf8').replace(/IPHONEOS_DEPLOYMENT_TARGET = (15(?:\.\d+)?|16(?:\.0)?);/g, 'IPHONEOS_DEPLOYMENT_TARGET = 16.1;'));
const storyboard = path.join(app, 'App/Base.lproj/Main.storyboard');
fs.writeFileSync(storyboard, fs.readFileSync(storyboard, 'utf8').replace('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="CebolaBridgeViewController" customModule="CebolaNative"'));
const plist = path.join(app, 'App/Info.plist');
let info = fs.readFileSync(plist, 'utf8');
if (!info.includes('<key>NSAllowsLocalNetworking</key>')) {
  info = info.replace('<dict>', '<dict>\n\t<key>NSAppTransportSecurity</key>\n\t<dict><key>NSAllowsLocalNetworking</key><true/></dict>');
}
fs.writeFileSync(plist, info);
console.log('Ponte iOS configurada para Nuvio + MPVKit, iOS 16.1+.');
