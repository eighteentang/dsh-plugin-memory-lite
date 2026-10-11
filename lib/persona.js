/**
 * persona.js —— 人设 / 工作规范与行为准则的存取（**插件自己的文件**）。
 *
 * 为什么不再写宿主的 AGENTS.md（2026-10-12 的返工）：
 *   第一版把这两块存进 `$DSH_HOME/AGENTS.md`，用我加的 `### 身份` / `### 核心原则` 当锚点 ——
 *   于是"标题行不能删"变成了对用户的约束。用户原话：**「这些###的标题不能去掉吗？不合理。」**
 *   他是对的：那些标题只是我写文件时顺手加的 markdown 结构，跟他的内容无关；
 *   我把实现细节暴露成了他的负担。
 *
 * 现在的模型（没有中间层）：
 *   · `人设设定` = `$DSH_HOME/memory-lite/persona/persona.md`
 *   · `工作规范` = `$DSH_HOME/memory-lite/persona/rules.md`
 *   **文件内容就是文本框内容** —— 不解析、不加标记、不要求任何标题。
 *   插件再把这两份渲染成一个 system prompt 段落（紧跟框架自己的人设段），
 *   于是"每轮必到"仍然成立 —— 而且靠的是框架的段落机制，不是我发明的锚点。
 *
 * 代价（已与用户确认）：内容随插件走 —— 插件停用/卸载，人设与准则就不生效了。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 两个槽位 → 界面上的名字 */
export const SLOT_LABEL = { persona: '人设设定', rules: '工作规范与行为准则' };
/** 两个槽位 → 文件名。文件内容就是文本框内容，一一对应。 */
export const SLOT_FILE = { persona: 'persona.md', rules: 'rules.md' };

export function fileFor(dir, slot) {
  return join(dir, SLOT_FILE[slot]);
}

/**
 * 读两个槽位。
 * @param {string} dir 存放目录
 * @returns {{ok:true, dir:string, persona:string, rules:string, mtimes:{persona:number, rules:number}} | {ok:false, error:string}}
 */
export function readPersona(dir) {
  try {
    const out = { ok: true, dir, persona: '', rules: '', mtimes: { persona: 0, rules: 0 } };
    for (const slot of Object.keys(SLOT_FILE)) {
      const file = fileFor(dir, slot);
      if (!existsSync(file)) continue;
      // 去掉 BOM：这个文件可能被别的编辑器写过（记事本会加 BOM），带进提示词里没意义
      out[slot] = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      out.mtimes[slot] = statSync(file).mtimeMs;
    }
    return out;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 写一个槽位。**写什么就是什么** —— 不加标题、不改结构、不补任何东西。
 * @param {string} dir
 * @param {'persona'|'rules'} slot
 * @param {string} text
 */
export function writePersona(dir, slot, text) {
  if (!Object.hasOwn(SLOT_FILE, slot)) return { ok: false, error: 'slot 必须是 persona 或 rules' };
  const body = String(text ?? '');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在 */
  }
  const file = fileFor(dir, slot);

  // 写前备份（正文文件本身没有历史，丢了就真丢了）。备份放 backup/ 子目录，不跟正文混在一起。
  let backup = null;
  if (existsSync(file)) {
    try {
      const bdir = join(dir, 'backup');
      mkdirSync(bdir, { recursive: true });
      backup = join(bdir, `${SLOT_FILE[slot]}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      copyFileSync(file, backup);
    } catch (error) {
      return { ok: false, error: `备份失败，已中止（文件没动）：${String(error?.message ?? error)}` };
    }
  }

  try {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file); // 原子替换，避免写到一半留半个文件
  } catch (error) {
    return { ok: false, error: `写入失败（备份在 ${backup ?? '无'}）：${String(error?.message ?? error)}` };
  }
  return { ok: true, file, backup, bytes: Buffer.byteLength(body, 'utf8'), mtime: statSync(file).mtimeMs };
}

/**
 * 渲染成**注入 system prompt 的段落**（纯函数，便于离线断言）。
 * 两份都空 → 返回 ''（调用方据此不注入空段落）。
 * @param {{persona?:string, rules?:string}} input
 * @returns {string}
 */
export function renderPersonaSection({ persona = '', rules = '' } = {}) {
  const p = String(persona ?? '').trim();
  const r = String(rules ?? '').trim();
  if (!p && !r) return '';
  const parts = [];
  if (p) parts.push(`【人设设定】\n${p}`);
  if (r) parts.push(`【工作规范与行为准则】\n${r}`);
  return parts.join('\n\n');
}
