#!/usr/bin/env node
/**
 * verify-package-meta.mjs —— 插件展示元数据契约校验（Dsh 的 icon/locale 机制）
 *
 * 为什么单独一个校验器：这套契约的**四种失效方式全是静默的** ——
 * 插件照常加载、功能照常工作，只是卡片上没名字/没图标，而且**不报错**。
 * 我是读了 `dsh-app-boot/lib/index.js` 的 `readPluginMeta()` 才拿到真实规则：
 *
 *   · 标题/描述来自 `locale/en.json` 里的 `{meta:{title,description}}`
 *     —— **不是** package.json 的 `meta` 字段（那个字段根本没人读）
 *   · `en.json` 是 base：它不存在 → 连其他语言都不查
 *   · locale 与 package.json 都经 **Node ESM 解析器**读取 → **受 exports 门控**
 *     缺 `./locale/*` → `ERR_PACKAGE_PATH_NOT_EXPORTED` → 被当成"没有元数据"静默略过
 *   · 图标是 package.json 顶层 `icon` = **相对路径**，svg/png/jpeg/webp，**≤256 KiB**，
 *     realpath 后不能跑出包目录；绝对路径或带 scheme 会抛
 *   · npm 发布时 `files` 数组不含 locale/icon → 包里就没有它们（又一个静默失效）
 *
 * 用法: node verify-package-meta.mjs [包目录]
 */
import { readFileSync, statSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, extname, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG_DIR = process.argv[2] ?? 'D:\\DSH-dev\\memory-lite';

// 与 dsh-app-boot/lib/index.js 保持一致
const ICON_MEDIA_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_ICON_BYTES = 256 * 1024;
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

const results = [];
const ok = (n, d = '') => results.push({ pass: true, n, d });
const bad = (n, d = '') => results.push({ pass: false, n, d });
const warn = (n, d = '') => results.push({ pass: true, n, d, warn: true });

console.log(`=== verify-package-meta: ${PKG_DIR} ===\n`);

// ── package.json ─────────────────────────────────────────────────────────
const pkgPath = join(PKG_DIR, 'package.json');
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
  ok('package.json 可解析');
} catch (error) {
  bad('package.json 可解析', String(error.message));
}

if (pkg) {
  // ① 那个没用的 meta 字段：留着会让人以为它有效
  if (pkg.meta === undefined) {
    ok('package.json 里没有无效的 `meta` 字段（它不被读，元数据在 locale/en.json）');
  } else {
    bad('package.json 里存在无效的 `meta` 字段', 'Dsh 只读 locale/en.json 的 meta；package.json 的 meta 没有任何作用，会误导人');
  }

  // ② exports 必须放行 locale（否则元数据静默消失）
  const exportsMap = pkg.exports ?? {};
  const coversLocale = (key) => {
    if (key === './locale/en.json') return true;
    if (key.includes('*')) {
      const [pre, post] = key.split('*');
      return './locale/en.json'.startsWith(pre) && './locale/en.json'.endsWith(post ?? '');
    }
    return false;
  };
  const localeKeys = Object.keys(exportsMap).filter(coversLocale);
  localeKeys.length
    ? ok('exports 放行 locale 子路径（否则 ERR_PACKAGE_PATH_NOT_EXPORTED 被静默略过）', localeKeys.join(', '))
    : bad('exports 放行 locale 子路径', `当前 exports: ${Object.keys(exportsMap).join(', ')}`);

  // ②b package.json 自身也要能经解析器读到
  Object.keys(exportsMap).some((k) => k === './package.json')
    ? ok('exports 放行 ./package.json')
    : bad('exports 放行 ./package.json');

  // ③ files 数组要包含 locale / icon（npm 发布时缺了它们 = 静默缺文件）
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  files.some((f) => f.startsWith('locale')) ? ok('files 包含 locale') : bad('files 包含 locale', JSON.stringify(files));
  files.some((f) => f === pkg.icon) ? ok('files 包含 icon') : bad('files 包含 icon', `icon=${pkg.icon}`);

  // ④ 图标
  if (typeof pkg.icon !== 'string' || !pkg.icon) {
    bad('package.json 声明了 icon');
  } else {
    if (isAbsolute(pkg.icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(pkg.icon)) {
      bad('icon 是相对路径', pkg.icon);
    } else {
      const iconPath = join(PKG_DIR, pkg.icon);
      const ext = extname(pkg.icon).toLowerCase();
      ICON_MEDIA_TYPES.has(ext) ? ok('icon 扩展名合法', ext) : bad('icon 扩展名合法', `${ext}（允许 SVG/PNG/JPEG/WebP）`);
      if (!existsSync(iconPath)) {
        bad('icon 文件存在', iconPath);
      } else {
        const st = statSync(iconPath);
        st.isFile() ? ok('icon 是普通文件') : bad('icon 是普通文件');
        st.size <= MAX_ICON_BYTES
          ? ok('icon 体积 ≤256 KiB', `${st.size} 字节`)
          : bad('icon 体积 ≤256 KiB', `${st.size} 字节`);
        const inside = relative(realpathSync(PKG_DIR), realpathSync(iconPath));
        !inside.startsWith('..') && !isAbsolute(inside)
          ? ok('icon realpath 后仍在包目录内')
          : bad('icon realpath 后仍在包目录内', inside);
      }
    }
  }
}

// ── locale ───────────────────────────────────────────────────────────────
const localeDir = join(PKG_DIR, 'locale');
const enPath = join(localeDir, 'en.json');

if (!existsSync(enPath)) {
  bad('locale/en.json 存在（它是 base：缺了它其他语言也不会被查）', enPath);
} else {
  ok('locale/en.json 存在（base 语言）');

  const readLocale = (file) => {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  };

  // en.json 的形状
  try {
    const en = readLocale(enPath);
    const meta = en?.meta;
    typeof meta?.title === 'string' && meta.title.trim()
      ? ok('en.json 的 meta.title 是非空字符串', meta.title)
      : bad('en.json 的 meta.title 是非空字符串', JSON.stringify(meta));
    typeof meta?.description === 'string' && meta.description.trim()
      ? ok('en.json 的 meta.description 是非空字符串', `${String(meta.description).slice(0, 40)}…`)
      : bad('en.json 的 meta.description 是非空字符串', JSON.stringify(meta));
  } catch (error) {
    bad('en.json 可解析', String(error.message));
  }

  // 每个 locale 文件名必须是合法语言 id（否则 Dsh 会抛错，整个元数据失败）
  const files = readdirSync(localeDir, { withFileTypes: true }).filter((e) => e.name.endsWith('.json'));
  const badNames = files.map((e) => e.name.slice(0, -5)).filter((lang) => !LANGUAGE_ID.test(lang));
  badNames.length === 0
    ? ok('全部 locale 文件名都是合法语言 id', files.map((f) => f.name).join(', '))
    : bad('全部 locale 文件名都是合法语言 id', `非法: ${badNames.join(', ')}`);

  // 每个语言都应有完整的 title+description（缺一个只会显示英文回退，不报错 → 容易漏）
  for (const f of files) {
    const lang = f.name.slice(0, -5);
    try {
      const data = readLocale(join(localeDir, f.name));
      const m = data?.meta;
      const good = typeof m?.title === 'string' && m.title.trim() && typeof m?.description === 'string' && m.description.trim();
      good ? ok(`locale/${f.name} 同时有 title 与 description`) : bad(`locale/${f.name} 同时有 title 与 description`, JSON.stringify(m));
    } catch (error) {
      bad(`locale/${f.name} 可解析`, String(error.message));
    }
    if (lang !== 'en') {
      // 检查翻译确实不同（复制英文过去是常见的假翻译）
      try {
        const cur = readLocale(join(localeDir, f.name))?.meta?.title;
        const en = readLocale(enPath)?.meta?.title;
        cur !== en ? ok(`locale/${f.name} 的标题与英文不同（不是照抄）`, `${en} → ${cur}`) : warn(`locale/${f.name} 的标题与英文相同`, '可能是有意为之，也可能忘了翻译');
      } catch {
        /* 上面已报 */
      }
    }
  }
}

// ── 与 dsh-app-boot 的常量做交叉核对（防止上游改了规则而我们还按旧规则写）──
const APP_BOOT = 'D:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-app-boot\\lib\\index.js';
void APP_BOOT; // asar 只能由宿主侧读，这里不读；规则来源见文件头注释
void pathToFileURL;
void dirname;

console.log('');
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? (r.warn ? '⚠️' : '✅') : '❌'} ${r.n}${r.d ? `  —— ${r.d}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n通过 ${pass}/${results.length}`);
console.log('\n规则来源: dsh-app-boot/lib/index.js 的 readPluginMeta() / iconOf() / dictionariesOf() / localizedText()');
process.exit(results.every((r) => r.pass) ? 0 : 1);
