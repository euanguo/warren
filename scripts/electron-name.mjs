/**
 * 让**开发态**的应用叫 Warren，而不是 Electron。
 *
 * 为什么需要它：`npm start` 跑的是 `node_modules/electron/dist/Electron.app`。
 * Dock 悬浮名 / Dock 里的名字取的是 **bundle 的目录名**，`app.name` 和 Info.plist 里的
 * `CFBundleName` 都不算数 —— 实测：plist 改成 Warren 之后 Dock 照样写 Electron；
 * 同一个 bundle 只换个目录名，Dock 立刻跟着变。所以办法是让目录叫 `Warren.app`：
 * 不复制 250MB，挂个软链，再把 electron 包的 `path.txt` 指过去（forge start 就是
 * import electron/index.js 拿可执行文件路径的）。
 *
 * 打包不受影响：`@electron/packager` 是把下载的 electron zip 解到临时目录再自己改名
 * （见 packager 的 mac.js `electronAppPath`），从不读这个 dist 目录。
 * 打包产物用 `productName: "Warren"`，本来就没这个问题。
 *
 * 为什么改 Info.plist 是安全的：npm 分发的那份 Electron.app 是 ad-hoc、**linker-signed**，
 * `codesign -dv` 明确写着 `Info.plist=not bound` —— plist 不在签名覆盖范围里，
 * 改它不会让签名失效（实测改完照常启动）。真正被打包签名的产物不走这条路。
 *
 * postinstall 里跑：`npm install` 会把 node_modules 里的 Electron 换回去，所以每次装完都补一遍。
 * 非 macOS、没装 electron、或者已经改过了，都直接跳过（退出 0）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NAME = 'Warren';
const DIST = path.join('node_modules', 'electron', 'dist');
const BUNDLE = path.join(DIST, 'Electron.app');
const ALIAS = path.join(DIST, `${NAME}.app`);
const PLIST = path.join(ALIAS, 'Contents', 'Info.plist');
const PATH_FILE = path.join('node_modules', 'electron', 'path.txt');
const EXEC = path.join(`${NAME}.app`, 'Contents', 'MacOS', 'Electron');

if (process.platform !== 'darwin' || !existsSync(BUNDLE)) {
  process.exit(0);
}

// 相对目标，dist 整体搬家也不会断
try {
  symlinkSync('Electron.app', ALIAS, 'dir');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}

// electron/index.js 用 path.txt 拼可执行文件路径，内容必须原样、不带换行
if (existsSync(PATH_FILE) && readFileSync(PATH_FILE, 'utf8').trim() !== EXEC) {
  writeFileSync(PATH_FILE, EXEC);
}

const read = (key) => {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', PLIST], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// 用 plutil 而不是自己解析：plist 可能是 XML 也可能是二进制
if (read('CFBundleName') !== NAME || read('CFBundleDisplayName') !== NAME) {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', NAME, PLIST]);
  }
}

console.log(`[electron-name] 开发态应用名 = ${NAME}（${ALIAS} → Electron.app，path.txt 指向它）`);
