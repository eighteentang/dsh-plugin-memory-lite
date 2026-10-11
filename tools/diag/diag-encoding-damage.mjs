// 评估 storage.js 的编码损坏能否逆向恢复
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'D:\\DSH-dev\\memory-lite\\lib\\storage.js';
const text = readFileSync(p, 'utf8');

const bad = (text.match(/[澶锛銆鐨勬槸涓杩欎釜]/g) ?? []).length;
console.log(`文件字符数 ${text.length}，疑似乱码字符 ${bad}`);

// 逆向：当前字符串（本应是 GBK 误解 UTF-8 的产物）→ 编回 GBK 字节 → 按 UTF-8 解
let recovered = null;
try {
  // 用 latin1 取回"原始字节序列"的近似，再用 TextDecoder 解 GBK 不行 —— 换个思路：
  // 损坏过程是：utf8bytes --decode(cp936)--> str --encode(utf8)--> file
  // 逆向：file --decode(utf8)--> str --encode(cp936)--> 原始 utf8bytes --decode(utf8)--> 原字符串
  const cp936ToBytes = (s) => {
    // Node 没有内置 GBK 编码器；用 TextDecoder('gbk') 只能解不能编。
    return null;
  };
  void cp936ToBytes;
} catch (e) {
  console.log('逆向失败', e.message);
}

// 无法编码 GBK 时，退而求其次：检查关键结构是否还在
const checks = {
  '有 DDL 数组': text.includes('const DDL = ['),
  '有 openMemory': text.includes('export function openMemory'),
  '有 search 函数': text.includes('function search('),
  '有 recordInjection': text.includes('function recordInjection'),
  '有 querySegments': text.includes('export function querySegments'),
  '有 rowToEntry': text.includes('function rowToEntry'),
  '模板字符串配对': (text.match(/`/g) ?? []).length % 2 === 0,
};
console.log(JSON.stringify(checks, null, 1));
console.log(`反引号对数检查：${(text.match(/`/g) ?? []).length} 个（应为偶数）`);

// 找出乱码最集中的行号，评估手工修复量
const lines = text.split('\n');
const badLines = [];
lines.forEach((l, i) => {
  if (/[澶锛銆鐨勬槸涓杩欎釜鍜岀殑浜嗕綘鎴戜粬]/.test(l)) badLines.push(i + 1);
});
console.log(`含乱码的行数：${badLines.length} / ${lines.length}`);
console.log(`前 20 个乱码行号：${badLines.slice(0, 20).join(', ')}`);
