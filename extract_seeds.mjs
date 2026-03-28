#!/usr/bin/env node
/**
 * VRoid Hub Seed Map Auto-Extractor
 * ==================================
 * 自动从 VRoid Hub 前端 JS 中提取最新的 seedMapStartingState。
 *
 * 原理:
 *   1. 访问 hub.vroid.com 获取 Next.js 构建 ID
 *   2. 下载 _buildManifest.js 获取所有 chunk 路径
 *   3. 扫描 chunk 搜索包含 "seedMap" 的 webpack module
 *   4. 提取 RC4 加密的字符串表和解密函数
 *   5. 执行旋转 + 解密，提取 seed map 的 key-value 对
 *
 * 用法:
 *   node extract_seeds.mjs             # 仅显示提取结果
 *   node extract_seeds.mjs --update    # 提取并自动更新 src/index.js
 */

import { setGlobalDispatcher, Agent, fetch } from 'undici';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Configuration ──────────────────────────────────────────────────────────────

const VROID_HUB_URL = 'https://hub.vroid.com/en';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};

// 用于在 chunk 中搜索包含 seed 逻辑的 webpack module 的关键词
const SEARCH_PATTERNS = ['seedMap', '2352940687395663367'];

// ─── HTTP Helpers ───────────────────────────────────────────────────────────────

setGlobalDispatcher(new Agent({ allowH2: true }));

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── Step 1: Get Build ID ───────────────────────────────────────────────────────

async function getBuildId() {
  console.log('[1/5] 获取 VRoid Hub 构建 ID...');
  const html = await fetchText(VROID_HUB_URL);

  // Next.js build ID 格式: /_next/static/{buildId}/_buildManifest.js
  const match = html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/);
  if (!match) throw new Error('无法从页面中提取 Next.js 构建 ID');

  console.log(`    构建 ID: ${match[1]}`);
  return match[1];
}

// ─── Step 2: Get Chunk List ─────────────────────────────────────────────────────

async function getChunkPaths(buildId) {
  console.log('[2/5] 获取 webpack chunk 列表...');
  const baseUrl = 'https://hub.vroid.com';
  const manifestUrl = `${baseUrl}/_next/static/${buildId}/_buildManifest.js`;
  const manifest = await fetchText(manifestUrl);

  const chunkPaths = [...new Set(manifest.match(/static\/chunks\/[^"'\s,\]]+\.js/g) || [])];
  console.log(`    找到 ${chunkPaths.length} 个 chunks`);
  return chunkPaths;
}

// ─── Step 3: Find Seed Module Chunk ─────────────────────────────────────────────

async function findSeedChunk(chunkPaths) {
  console.log('[3/5] 搜索包含 seed 逻辑的 chunk...');
  const baseUrl = 'https://hub.vroid.com';

  for (const chunkPath of chunkPaths) {
    const url = `${baseUrl}/_next/${chunkPath}`;
    try {
      const content = await fetchText(url);
      const hasAll = SEARCH_PATTERNS.every(p => content.includes(p));
      if (hasAll) {
        const filename = chunkPath.split('/').pop();
        console.log(`    ✓ 找到目标 chunk: ${filename} (${(content.length / 1024).toFixed(0)} KB)`);
        return content;
      }
    } catch {
      // skip failed chunks
    }
  }
  throw new Error('未找到包含 seed 逻辑的 chunk');
}

// ─── Step 4: Extract & Decode the Seed Module ───────────────────────────────────

/**
 * 从大型 chunk 中提取包含 seed 逻辑的 webpack module，
 * 然后解密 RC4 混淆的字符串表以获取 seed map 值。
 *
 * 锚点: 使用已知的 seed 值字面量（如 "9402684" 或其他数字字符串）
 * 来定位 seed module，而非 "seedMap"（后者出现在 React 组件代码中）。
 */
function extractSeedMap(chunkContent) {
  console.log('[4/5] 提取并解密 seed module...');

  // -- 4a: 定位 seed module --
  // 搜索 i.d(t,{i:()=>FUNC}) 导出标记，它在 seed 值附近
  // 先找到已知的 seed 值字面量 "9402684" 或其他数字字符串作为锚点
  const knownSeedPatterns = ['"9402684"', '"74670526"', '"38325553"', '"1289559305"'];
  let anchorIdx = -1;
  let anchorPattern = '';
  for (const p of knownSeedPatterns) {
    const idx = chunkContent.indexOf(p);
    if (idx !== -1) { anchorIdx = idx; anchorPattern = p; break; }
  }
  if (anchorIdx === -1) {
    // 备选: 搜索 RC4 模块导出模式 + SHA-1 哈希逻辑的組合
    // 查找包含 "SHA-1" 或 sha1 的模块附近的 i.d 导出
    const sha1Idx = chunkContent.indexOf('"sha1"');
    if (sha1Idx !== -1) anchorIdx = sha1Idx;
    else throw new Error('无法定位 seed module (未找到已知 seed 值或 SHA-1 引用)');
  }
  console.log(`    锚点: ${anchorPattern || '"sha1"'} @ 位置 ${anchorIdx}`);

  // 从锚点向前搜索最近的 i.d(t,{i:()=>...}) 导出标记
  const backSearchStart = Math.max(0, anchorIdx - 10000);
  const backRegion = chunkContent.substring(backSearchStart, anchorIdx);
  const exportMatches = [...backRegion.matchAll(/i\.d\(t,\{i:\(\)=>(\w+)\}\)/g)];
  if (exportMatches.length === 0) throw new Error('未找到 webpack module 导出标记');
  const lastExport = exportMatches[exportMatches.length - 1];
  const exportAbsIdx = backSearchStart + lastExport.index;
  console.log(`    导出标记: i.d(t,{i:()=>${lastExport[1]}}) @ 位置 ${exportAbsIdx}`);

  // -- 4b: 从导出标记回溯找到 module 开头 --
  // Webpack modules format: NUMBER:(e,t,i)=>{ ... }
  let moduleStart = exportAbsIdx;
  for (let j = exportAbsIdx - 1; j > Math.max(0, exportAbsIdx - 15000); j--) {
    // 匹配 "数字:(e,t,i)" 或 "数字:(e,t,i)=>"
    const slice = chunkContent.substring(j, j + 15);
    if (/^\d+:\(e,t,i/.test(slice)) {
      moduleStart = j;
      break;
    }
  }

  // -- 4c: 找到 module 结尾 (匹配花括号) --
  let braceCount = 0, started = false, moduleEnd = exportAbsIdx;
  for (let j = moduleStart; j < Math.min(chunkContent.length, moduleStart + 50000); j++) {
    if (chunkContent[j] === '{') { braceCount++; started = true; }
    if (chunkContent[j] === '}') { braceCount--; }
    if (started && braceCount === 0) { moduleEnd = j + 1; break; }
  }

  const moduleCode = chunkContent.substring(moduleStart, moduleEnd);
  console.log(`    Module 大小: ${moduleCode.length} 字节`);

  // 验证提取的 module 包含关键内容
  if (!moduleCode.includes('i.d(t,')) {
    throw new Error('提取的 module 不包含导出标记，定位可能有误');
  }

  // -- 4d: 提取字符串表 --
  const arrayMatch = moduleCode.match(/function\s+\w+\(\)\s*\{\s*let\s+\w+\s*=\s*\[([\s\S]*?)\];\s*return/);
  if (!arrayMatch) throw new Error('未找到字符串表数组');

  // 使用 JS 的原生 Parser 提取字符串数组，避免任何正则边界问题
  let stringArray = [];
  try {
    stringArray = new Function('return [' + arrayMatch[1] + ']')();
  } catch (err) {
    throw new Error('无法解析字符串表数组: ' + err.message);
  }

  console.log(`    字符串表: ${stringArray.length} 条`);

  // -- 4e: 提取 RC4 函数的基础偏移 --
  const offsetMatch = moduleCode.match(/function\s+(\w+)\(e,\s*t\)\s*\{\s*e\s*-=\s*(\d+)/);
  if (!offsetMatch) throw new Error('未找到 RC4 函数的偏移值');
  const decryptFuncName = offsetMatch[1];
  const baseOffset = parseInt(offsetMatch[2], 10);
  console.log(`    RC4 函数: ${decryptFuncName}(), 偏移: ${baseOffset}`);

  // -- 4f: 提取旋转目标值 --
  const rotationMatch = moduleCode.match(/===\s*(\d{4,10})\)\s*break/);
  if (!rotationMatch) throw new Error('未找到旋转目标值');
  const rotationTarget = parseInt(rotationMatch[1], 10);
  console.log(`    旋转目标值: ${rotationTarget}`);

  // -- 4g: 提取旋转公式 --
  const formulaRegion = moduleCode.match(/for\s*\(;;\)\s*try\s*\{([\s\S]*?)===\s*\d+\)\s*break/);
  if (!formulaRegion) throw new Error('未找到旋转公式区域');
  const formulaCode = formulaRegion[1];

  // -- 4h: 实现 RC4 解密 --
  const currentArray = [...stringArray];

  // Base64 解码 (自定义字母表: 小写在前)
  function customBase64Decode(str) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
    let decoded = '';
    for (let i = 0, r, n, a = 0; (n = str.charAt(a++));
      ~n && (r = i % 4 ? 64 * r + n : n, i++ % 4) &&
      (decoded += String.fromCharCode(255 & r >> (-2 * i & 6))))
      n = charset.indexOf(n);

    let result = '';
    for (let i = 0; i < decoded.length; i++)
      result += '%' + ('00' + decoded.charCodeAt(i).toString(16)).slice(-2);
    return decodeURIComponent(result);
  }

  // RC4 解密
  function rc4Decrypt(encoded, key) {
    const decoded = customBase64Decode(encoded);
    let r = [], n = 0, a, o = '';
    for (let i = 0; i < 256; i++) r[i] = i;
    for (let i = 0; i < 256; i++) {
      n = (n + r[i] + key.charCodeAt(i % key.length)) % 256;
      a = r[i]; r[i] = r[n]; r[n] = a;
    }
    let i = 0; n = 0;
    for (let t = 0; t < decoded.length; t++) {
      n = (n + r[i = (i + 1) % 256]) % 256;
      a = r[i]; r[i] = r[n]; r[n] = a;
      o += String.fromCharCode(decoded.charCodeAt(t) ^ r[(r[i] + r[n]) % 256]);
    }
    return o;
  }

  // a() 函数的完整实现 (带缓存)
  const decryptCache = {};
  function decryptString(idx, key) {
    const adjustedIdx = idx - baseOffset;
    const cacheKey = `${adjustedIdx}:${key}`;
    if (decryptCache[cacheKey]) return decryptCache[cacheKey];
    const encoded = currentArray[adjustedIdx];
    if (encoded === undefined) return undefined;
    const result = rc4Decrypt(encoded, key);
    decryptCache[cacheKey] = result;
    return result;
  }

  // -- 4i: 执行字符串表旋转 --
  function evaluateRotationFormula() {
    let evalCode = formulaCode
      .replace(/parseInt\s*\(\s*\w+\((\d+),\s*"([^"]+)"\)\s*\)/g,
        (_, idx, key) => `parseInt(decryptString(${idx},"${key}"))`)
      .replace(/===\s*\d+/, '');
    evalCode = evalCode.replace(/^\s*if\s*\(/, '');
    try {
      const fn = new Function('decryptString', `return (${evalCode})`);
      return fn(decryptString);
    } catch (e) {
      console.log('Eval error:', e);
      return NaN;
    }
  }

  let rotated = false;
  console.log('    [Debug] formulaCode:', formulaCode);
  
  for (let attempt = 0; attempt < currentArray.length; attempt++) {
    Object.keys(decryptCache).forEach(k => delete decryptCache[k]);
    const value = evaluateRotationFormula();
    if (attempt === 0) {
      const dbgCode = formulaCode
        .replace(/parseInt\s*\(\s*\w+\((\d+),\s*"([^"]+)"\)\s*\)/g,
          (_, idx, key) => `parseInt(decryptString(${idx},"${key}"))`)
        .replace(/===\s*\d+/, '').replace(/^\s*if\s*\(/, '');
      console.log('    [Debug] evalCode:', dbgCode);
      console.log('    [Debug] value on attempt 0:', value, 'target:', rotationTarget);
    }
    if (value === rotationTarget) {
      console.log(`    ✓ 字符串表旋转完成 (${attempt} 次旋转)`);
      rotated = true;
      break;
    }
    currentArray.push(currentArray.shift());
  }
  if (!rotated) throw new Error('字符串表旋转失败');

  // -- 4j: 提取 seed map 配置对象的属性 --
  let objVarName = '';
  let objCode = '';
  // find "9402684" literal or uGHKa
  const seedPattern = moduleCode.includes('"9402684"') ? '"9402684"' : (moduleCode.includes('uGHKa') ? 'uGHKa' : null);
  if (!seedPattern) throw new Error('未找到 seed map 配置对象锚点');
  const anchorIdx2 = moduleCode.indexOf(seedPattern);
  
  // 回溯找到对象变量名 "let o={" 或 ",o={"
  let objStart = -1;
  for (let j = anchorIdx2; j > Math.max(0, anchorIdx2 - 1000); j--) {
    if (moduleCode[j] === '{' && moduleCode[j-1] === '=') {
      const matchText = moduleCode.substring(j - 20, j - 1);
      const match = matchText.match(/(?:let\s+|const\s+|var\s+|,\s*|\b)(\w+)\s*$/);
      if (match) {
        objStart = j;
        objVarName = match[1];
        break;
      }
    }
  }
  if (!objVarName) throw new Error('未定位到配置对象起始位置');
  
  // 匹配结束的 '}'
  let braceCount2 = 0;
  let objEnd = -1;
  for (let j = objStart; j < Math.min(moduleCode.length, objStart + 20000); j++) {
    if (moduleCode[j] === '{') braceCount2++;
    if (moduleCode[j] === '}') {
      braceCount2--;
      if (braceCount2 === 0) {
        objEnd = j + 1;
        break;
      }
    }
  }
  objCode = moduleCode.substring(objStart, objEnd);

  // 解码对象中所有属性值
  const propRegex = /(\w+)\s*:\s*(?:(\w+)\((\d+),\s*"([^"]+)"\)(?:\s*\+\s*(?:(\w+)\((\d+),\s*"([^"]+)"\)|"([^"]*)"))?|"([^"]*)"|(function\([^)]*\)\s*\{[^}]*\}))/g;
  const objProps = {};
  let pm;
  while ((pm = propRegex.exec(objCode)) !== null) {
    const propName = pm[1];
    if (pm[9] !== undefined) {
      objProps[propName] = pm[9]; // 字符串字面量
    } else if (pm[10]) {
      continue; // 函数值, 跳过
    } else if (pm[3]) {
      let value = decryptString(parseInt(pm[3], 10), pm[4]);
      if (pm[5] && pm[6] && pm[7]) {
        value += decryptString(parseInt(pm[6], 10), pm[7]);
      } else if (pm[8] !== undefined) {
        value += pm[8];
      }
      objProps[propName] = value;
    }
  }

  console.log('\n    解码后的配置对象属性:');
  for (const [k, v] of Object.entries(objProps)) {
    if (typeof v === 'string' && v.length < 50) {
      console.log(`      ${k} = "${v}"`);
    }
  }

  // -- 4k: 提取 seed map 赋值逻辑 --
  const seedMapEntries = {};

  // 提取局部变量字符串表 (例如 let r="pyfM", s="N#QU")
  const localVars = {};
  const stringBefore = moduleCode.substring(Math.max(0, objStart - 150), objStart);
  let varsStr = '';
  // find the last declaration keyword
  const lastLetIdx = stringBefore.lastIndexOf('let ');
  if (lastLetIdx !== -1) {
    varsStr = stringBefore.substring(lastLetIdx + 4);
    const varDefs = varsStr.split(',');
    for (const def of varDefs) {
      const parts = def.split('=');
      if (parts.length >= 2) {
        let varName = parts[0].trim();
        const varValue = parts.slice(1).join('=').trim();
        // remove any trailing punctuation just in case
        varName = varName.replace(/[^a-zA-Z0-9_$]/g, '');
        if (varValue.startsWith('"') || varValue.startsWith("'")) {
          localVars[varName] = varValue.replace(/["']/g, '');
        }
      }
    }
  }
  console.log('    [Debug] localVars:', JSON.stringify(localVars));

  function resolveKey(keyOrVar) {
    if (keyOrVar.startsWith('"') || keyOrVar.startsWith("'")) return keyOrVar.replace(/["']/g, '');
    return localVars[keyOrVar] || keyOrVar;
  }

  // 匹配 l[o.PROP1] = o.PROP2
  const simpleAssignRegex = new RegExp(`\\w+\\[${objVarName}\\.(\\w+)\\]\\s*=\\s*${objVarName}\\.(\\w+)`, 'g');
  let sm2;
  while ((sm2 = simpleAssignRegex.exec(moduleCode)) !== null) {
    const keyProp = sm2[1];
    const valProp = sm2[2];
    const key = objProps[keyProp];
    const val = objProps[valProp];
    if (key && val && !isNaN(Number(key)) && !isNaN(Number(val))) {
      seedMapEntries[key] = val;
    }
  }

  // 支持 a(IDX, KEY) 方式，其中 KEY 可能是字面量也可能是变量
  // 匹配 l[o.PROP] = o[a(IDX, KEY_VAR)] 或 l[o[a(IDX, KEY_VAR)]] = o[a(IDX, KEY_VAR)]
  const assignRegex = new RegExp(
    `(\\w+)\\[${objVarName}\\.(\\w+)\\]\\s*=\\s*${objVarName}\\[\\w+\\((\\d+),\\s*([a-zA-Z0-9_"'$]+)\\)\\]` +
    `|` +
    `(\\w+)\\[${objVarName}\\[\\w+\\((\\d+),\\s*([a-zA-Z0-9_"'$]+)\\)\\]\\]\\s*=\\s*${objVarName}\\[\\w+\\((\\d+),\\s*([a-zA-Z0-9_"'$]+)\\)\\]`,
    'g'
  );

  let am;
  while ((am = assignRegex.exec(moduleCode)) !== null) {
    if (am[1]) {
      const keyProp = am[2];
      const valPropKey = resolveKey(am[4]);
      const valProp = decryptString(parseInt(am[3], 10), valPropKey);
      const key = objProps[keyProp];
      const val = objProps[valProp];
      if (key && val && !isNaN(Number(key)) && !isNaN(Number(val))) seedMapEntries[key] = val;
    }
    if (am[5]) {
      const keyPropKey = resolveKey(am[7]);
      const valPropKey = resolveKey(am[9]);
      const keyProp = decryptString(parseInt(am[6], 10), keyPropKey);
      const valProp = decryptString(parseInt(am[8], 10), valPropKey);
      const key = objProps[keyProp];
      const val = objProps[valProp];
      if (key && val && !isNaN(Number(key)) && !isNaN(Number(val))) seedMapEntries[key] = val;
    }
  }

  // 验证提取结果
  if (Object.keys(seedMapEntries).length === 0) {
    throw new Error('未能提取任何 seed map 条目');
  }

  // -- 4l: 检测 computeSeedMap 运算逻辑 --
  let sopOperation = 'XOR';
  if (moduleCode.includes(',10)^')) sopOperation = 'XOR';
  let normalOperation = 'ADD';
  if (moduleCode.includes('+parseInt(e,10)') || moduleCode.includes('parseInt(e,10)')) {
    normalOperation = 'ADD';
  }

  return { seedMap: seedMapEntries, sopOperation, normalOperation };
}

// ─── Step 5: Display & Optionally Update ────────────────────────────────────────

function formatSeedMap(seedMap) {
  const entries = Object.entries(seedMap)
    .map(([k, v]) => `\t${k}: ${v},`)
    .join('\n');
  return `const seedMapStartingState = {\n${entries}\n};`;
}

async function updateIndexJs(seedMap) {
  const indexPath = join(__dirname, 'src', 'index.js');
  let content = await readFile(indexPath, 'utf-8');

  const seedMapRegex = /const seedMapStartingState\s*=\s*\{[^}]*\};/;
  if (!seedMapRegex.test(content)) {
    throw new Error('在 src/index.js 中未找到 seedMapStartingState');
  }

  const newSeedMap = formatSeedMap(seedMap);
  content = content.replace(seedMapRegex, newSeedMap);

  await writeFile(indexPath, content, 'utf-8');
  console.log(`    ✓ 已更新 src/index.js`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const shouldUpdate = args.includes('--update');

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   VRoid Hub Seed Map 自动提取工具            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    // Step 1: 获取构建 ID
    const buildId = await getBuildId();

    // Step 2: 获取 chunk 列表
    const chunkPaths = await getChunkPaths(buildId);

    // Step 3: 找到目标 chunk
    const chunkContent = await findSeedChunk(chunkPaths);

    // Step 4: 提取并解密 seed map
    const { seedMap, sopOperation, normalOperation } = extractSeedMap(chunkContent);

    // Step 5: 输出结果
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║              提取结果                         ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    console.log(formatSeedMap(seedMap));
    console.log(`\ncomputeSeedMap 运算逻辑:`);
    console.log(`  s=op 路径: ${sopOperation} (value ${sopOperation === 'XOR' ? '^' : '+'} hashInt)`);
    console.log(`  普通路径:  ${normalOperation} (value + modelId)`);

    // 与当前代码对比
    const indexPath = join(__dirname, 'src', 'index.js');
    const currentCode = await readFile(indexPath, 'utf-8');
    const currentMatch = currentCode.match(/const seedMapStartingState\s*=\s*\{([^}]*)\}/);
    if (currentMatch) {
      const currentEntries = {};
      const entryRegex = /(\d+)\s*:\s*(\d+)/g;
      let em;
      while ((em = entryRegex.exec(currentMatch[1])) !== null) {
        currentEntries[em[1]] = em[2];
      }

      const currentStr = JSON.stringify(currentEntries);
      const newStr = JSON.stringify(seedMap);
      if (currentStr === newStr) {
        console.log('\n✅ src/index.js 中的 seedMapStartingState 已是最新，无需更新。');
      } else {
        console.log('\n⚠  src/index.js 中的 seedMapStartingState 需要更新:');
        console.log(`   当前: ${JSON.stringify(currentEntries)}`);
        console.log(`   最新: ${JSON.stringify(seedMap)}`);

        if (shouldUpdate) {
          await updateIndexJs(seedMap);
        } else {
          console.log('\n   运行 node extract_seeds.mjs --update 自动更新');
        }
      }
    }

    console.log('\n完成。');
  } catch (err) {
    console.error(`\n❌ 错误: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
