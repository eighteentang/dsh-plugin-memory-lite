#!/usr/bin/env node
/**
 * release-copy.mjs —— 把插件从开发目录发布到用户包
 *
 * 开发在 `D:\DSH-dev\memory-lite`（用户看不到），发布到 `D:\EasyDSH\memory-lite`（产品）。
 *
 * ⚠ 用**白名单**而不是黑名单：黑名单一定会漏（"靠记得排除什么"是本项目反复失败的模式）。
 *   这里把"要发布什么"写死，多一个文件都进不去；同时会清掉目标目录里**不在白名单**的残留，
 *   避免上一版的旧文件留在产品里。
 *
 * 安全：只允许在目标路径确实以 `EasyDSH\memory-lite` 结尾时操作；不做递归删除整个目录。
 *
 * 用法:
 *   node release-copy.mjs             # 演练（只报告，不写）
 *   node release-copy.mjs --apply     # 真的复制
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const SRC = 'D:\\DSH-dev\\memory-lite';
const DST = 'D:\\EasyDSH\\memory-lite';
const APPLY = process.argv.includes('--apply');

/**
 * 白名单：运行插件**真正需要**的东西。开发产物（tools/ probe/ AGENTS.md 等）一律不进。
 * `package.json` 的 `files` 字段是给 npm 的；这里是给"整份复制进用户包"用的，两者应一致。
 */
const WHITELIST = [
  'index.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'icon.svg',
  'lib/',
  'client/',
  'locale/',
];

/** 目标目录里即使出现也允许保留的（不参与"清残留"） */
const ALLOWED_EXTRA = [];

/**
 * 垃圾文件模式 —— 在白名单目录里出现就**报错停止**，而不是静默复制出去。
 *
 * 为什么需要：白名单里写 `lib/` 是**目录**，目录一放行，里面的任何东西都会跟着出去。
 * 实测过：`lib/storage.js.corrupt-bak`（我一次误操作留下的备份）就被演练抓到了。
 * 所以"白名单"必须补一条"目录内也要筛"的规则，否则它只是变相的黑名单。
 */
const JUNK_PATTERNS = [
  /\.corrupt-bak$/i,
  /\.bak$/i,
  /\.orig$/i,
  /~$/,
  /\.tmp$/i,
  /^\.tmp-/i,
  /\.log$/i,
  /\.map$/i,
  /\.tsbuildinfo$/i,
  /^(node_modules|\.git|\.cache|dist|build)$/,
];

// ── 安全闸门：确认目标路径真的是我们以为的那个 ──────────────────────────
const resolvedDst = resolve(DST);
if (!/EasyDSH[\\/]memory-lite$/.test(resolvedDst)) {
  console.error(`拒绝执行：目标路径不符合预期 → ${resolvedDst}`);
  process.exit(2);
}
if (!existsSync(SRC)) {
  console.error(`源目录不存在：${SRC}`);
  process.exit(2);
}

const walk = (dir, base = '') => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
};

// ── 算出"应该发布哪些文件" ───────────────────────────────────────────────
const srcFiles = new Set();
for (const item of WHITELIST) {
  const abs = join(SRC, item);
  if (!existsSync(abs)) {
    console.error(`❌ 白名单里的条目在源目录不存在：${item}`);
    process.exit(2);
  }
  if (statSync(abs).isDirectory()) {
    for (const f of walk(abs, item.replace(/\/$/, ''))) srcFiles.add(f);
  } else {
    srcFiles.add(item);
  }
}

console.log(`源: ${SRC}`);
console.log(`目标: ${resolvedDst}`);
console.log(`模式: ${APPLY ? '真的复制 (--apply)' : '演练（不写任何文件）'}\n`);

// ── 先筛垃圾：白名单目录里的垃圾必须**报错**，不能静默带出去 ─────────────
const junk = [...srcFiles].filter((f) => JUNK_PATTERNS.some((re) => re.test(f.split('/').pop())));
if (junk.length) {
  console.error('❌ 白名单目录里发现不该发布的东西（先清理，别让它们进产品）：');
  for (const f of junk) console.error(`   ${f}`);
  process.exit(1);
}

console.log(`要发布 ${srcFiles.size} 个文件：`);
for (const f of [...srcFiles].sort()) console.log(`  ✓ ${f}`);

// ── 目标目录里的残留（在白名单之外）────────────────────────────────────
const stale = [];
if (existsSync(DST)) {
  for (const f of walk(DST)) {
    const norm = f.replace(/\\/g, '/');
    if (!srcFiles.has(norm) && !ALLOWED_EXTRA.includes(norm)) stale.push(norm);
  }
}
if (stale.length) {
  console.log(`\n目标目录里有 ${stale.length} 个不在白名单的文件（会被清掉，避免旧文件留在产品里）：`);
  for (const f of stale.sort()) console.log(`  ✗ ${f}`);
}

if (!APPLY) {
  console.log('\n演练结束。加 --apply 才会真的写。');
  process.exit(0);
}

// ── 执行 ────────────────────────────────────────────────────────────────
mkdirSync(DST, { recursive: true });
for (const rel of srcFiles) {
  const from = join(SRC, ...rel.split('/'));
  const to = join(DST, ...rel.split('/'));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`\n已复制 ${srcFiles.size} 个文件。`);

// 清残留（逐个删文件 + 删空目录，不做递归删除整目录）
for (const rel of stale) {
  const abs = join(DST, ...rel.split('/'));
  const guard = resolve(abs);
  if (!guard.startsWith(resolvedDst)) {
    console.error(`拒绝删除越界路径：${guard}`);
    continue;
  }
  rmSync(guard, { force: true });
}
console.log(stale.length ? `已清掉 ${stale.length} 个残留文件。` : '没有残留需要清。');

// ── 收尾自检：产品里不该出现开发产物 ──────────────────────────────────
// ⚠ 必须按**路径段**匹配，不能用子串 —— 第一版我写的是 `f.includes(bad)`，
//   于是 `lib/tools.js`（正常的记忆工具源文件）被子串 `tools` 误判成开发产物目录。
//   这类"校验器自己写错"的误报会让人去查代码，而代码是对的（经验库 E42/E43）。
const FORBIDDEN_SEGMENTS = ['tools', 'probe', 'node_modules', 'archive'];
const FORBIDDEN_FILES = ['AGENTS.md'];
const leftovers = walk(DST).filter((f) => {
  const parts = f.replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1];
  return (
    FORBIDDEN_SEGMENTS.some((bad) => parts.includes(bad)) ||
    FORBIDDEN_FILES.includes(name) ||
    JUNK_PATTERNS.some((re) => re.test(name))
  );
});
if (leftovers.length) {
  console.error(`\n❌ 产品目录里发现开发产物：\n  ${leftovers.join('\n  ')}`);
  process.exit(1);
}
// 顺带确认 locale 与 icon 真的到了（这两个缺了会让插件卡片静默没名字/没图标）
for (const must of ['locale/en.json', 'locale/zh.json', 'icon.svg']) {
  if (!existsSync(join(DST, ...must.split('/')))) {
    console.error(`\n❌ 缺少发布必需文件：${must}`);
    process.exit(1);
  }
}
void readFileSync;
console.log('\n✅ 发布完成，且没有把开发产物带进去。');
