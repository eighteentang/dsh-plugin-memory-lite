#!/usr/bin/env node
/**
 * diag-plugin-meta.mjs —— 模拟宿主 `readPluginMeta()`，打印插件卡片**实际会显示什么**
 *
 * 为什么需要它：这套元数据的失效是**静默**的 ——
 * 没读到就回退成默认图标/包名，界面上不报任何错。
 * 这个脚本按 `dsh-app-boot/lib/index.js` 的真实逻辑复算一遍，
 * 让你能直接看到「标题映射、描述、图标是不是真的被采纳」。
 *
 * 规则来源（逐条对着源码写的）：
 *   readPluginMeta() / dictionariesOf() / localizedText() / iconOf()
 *
 * 用法: node diag-plugin-meta.mjs <包目录> [...更多包目录]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const MAX_ICON_BYTES = 256 * 1024;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

for (const dir of process.argv.slice(2)) {
  console.log('='.repeat(64));
  console.log(`包目录: ${dir}`);
  console.log('='.repeat(64));

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log('  ❌ 没有 package.json\n');
    continue;
  }
  const pkg = readJson(pkgPath);

  // ── 1. locale 字典（en.json 是 base；它不存在就一本字典都没有）─────────
  const localeDir = join(dir, 'locale');
  const enPath = join(localeDir, 'en.json');
  const dictionaries = new Map();
  if (!existsSync(enPath)) {
    console.log('  ⚠ 没有 locale/en.json（base）→ 标题/描述走 package.json 回退');
  } else {
    for (const entry of readdirSync(localeDir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      const language = entry.name.slice(0, -5);
      if (!LANGUAGE_ID.test(language)) {
        console.log(`  ❌ locale/${entry.name}: 文件名不是合法语言 id → 宿主会抛错，整个元数据失败`);
        continue;
      }
      try {
        const parsed = readJson(join(localeDir, entry.name));
        const meta = parsed?.meta ?? {};
        dictionaries.set(language.toLowerCase(), {
          title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : undefined,
          description: typeof meta.description === 'string' && meta.description.trim() ? meta.description : undefined,
        });
        console.log(`  ✓ locale/${entry.name} → title=${JSON.stringify(meta.title)} description=${meta.description ? '有' : '无'}`);
      } catch (error) {
        console.log(`  ❌ locale/${entry.name} 解析失败: ${error.message}`);
      }
    }
  }

  // ── 2. localizedText：没有翻译 → 回退；有翻译 → {en: 回退, ...翻译} ────
  const localizedText = (field, fallback, finalFallback) => {
    const entries = [...dictionaries].flatMap(([lang, fields]) => (fields[field] === undefined ? [] : [[lang, fields[field]]]));
    if (entries.length === 0) return fallback;
    return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) };
  };

  const title = localizedText('title', pkg.name, pkg.name);
  const description = localizedText('description', pkg.description, '');
  console.log('\n  宿主会返回的 display 字段：');
  console.log(`    title       = ${JSON.stringify(title)}`);
  console.log(`    description = ${JSON.stringify(description)}`);

  // ── 3. icon ────────────────────────────────────────────────────────────
  const iconValue = pkg.icon;
  if (iconValue === undefined) {
    console.log('    icon        = （未声明）→ 界面显示**默认图标**');
  } else {
    const ext = extname(String(iconValue)).toLowerCase();
    const mediaType = ICON_MEDIA_TYPES.get(ext);
    const iconPath = join(dir, String(iconValue));
    const problems = [];
    if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(String(iconValue)) || String(iconValue).startsWith('/')) problems.push('必须是相对路径');
    if (!mediaType) problems.push(`扩展名 ${ext} 不支持（只允许 svg/png/jpeg/webp）`);
    if (!existsSync(iconPath)) problems.push('文件不存在');
    else {
      const size = statSync(iconPath).size;
      if (size > MAX_ICON_BYTES) problems.push(`${size} 字节 > 256 KiB`);
      if (!problems.length) {
        console.log(`    icon        = ✅ data:${mediaType};base64,…（${size} 字节，界面会用它）`);
      }
    }
    if (problems.length) console.log(`    icon        = ❌ ${problems.join('；')}`);
  }

  // ── 4. exports 门控（最常见的静默失效）─────────────────────────────────
  const exportsMap = Object.keys(pkg.exports ?? {});
  const allowsLocale = exportsMap.some((k) => k === './locale/en.json' || (k.includes('*') && './locale/en.json'.startsWith(k.split('*')[0]) && './locale/en.json'.endsWith(k.split('*')[1] ?? '')));
  if (existsSync(enPath) && !allowsLocale) {
    console.log('\n  ❌ 致命：有 locale 文件，但 exports 没放行 →');
    console.log('     宿主解析时得到 ERR_PACKAGE_PATH_NOT_EXPORTED，会把它当"没有元数据"**静默略过**');
    console.log(`     当前 exports: ${exportsMap.join(', ')}`);
  } else if (existsSync(enPath)) {
    console.log('\n  ✓ exports 放行了 locale，元数据能被读到');
  }
  console.log('');
}
