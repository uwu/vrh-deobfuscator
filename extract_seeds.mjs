#!/usr/bin/env node
/**
 * VRoid Hub Seed Map Auto-Extractor
 * ==================================
 * Automatically extracts the latest seedMapStartingState from VRoid Hub's frontend JS.
 *
 * How it works:
 * 1. Visit hub.vroid.com to get the Next.js build ID
 * 2. Download _buildManifest.js to get all chunk paths
 * 3. Scan chunks to find the webpack module containing "seedMap"
 * 4. Extract the RC4 encrypted string table and decryption function
 * 5. Execute rotation + decryption to extract seed map key-value pairs
 *
 * Usage:
 * node extract_seeds.mjs             # Only show extraction results
 * node extract_seeds.mjs --update    # Extract and automatically update src/index.js
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

// Keywords used to search for the webpack module containing the seed logic in the chunks
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
  console.log('[1/5] Fetching VRoid Hub build ID...');
  const html = await fetchText(VROID_HUB_URL);

  // Next.js build ID format: /_next/static/{buildId}/_buildManifest.js
  const match = html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/);
  if (!match) throw new Error('Failed to extract Next.js build ID from the page');

  console.log(`    Build ID: ${match[1]}`);
  return match[1];
}

// ─── Step 2: Get Chunk List ─────────────────────────────────────────────────────

async function getChunkPaths(buildId) {
  console.log('[2/5] Fetching webpack chunk list...');
  const baseUrl = 'https://hub.vroid.com';
  const manifestUrl = `${baseUrl}/_next/static/${buildId}/_buildManifest.js`;
  const manifest = await fetchText(manifestUrl);

  const chunkPaths = [...new Set(manifest.match(/static\/chunks\/[^"'\s,\]]+\.js/g) || [])];
  console.log(`    Found ${chunkPaths.length} chunks`);
  return chunkPaths;
}

// ─── Step 3: Find Seed Module Chunk ─────────────────────────────────────────────

async function findSeedChunk(chunkPaths) {
  console.log('[3/5] Searching for the chunk containing seed logic...');
  const baseUrl = 'https://hub.vroid.com';

  for (const chunkPath of chunkPaths) {
    const url = `${baseUrl}/_next/${chunkPath}`;
    try {
      const content = await fetchText(url);
      const hasAll = SEARCH_PATTERNS.every(p => content.includes(p));
      if (hasAll) {
        const filename = chunkPath.split('/').pop();
        console.log(`    ✓ Target chunk found: ${filename} (${(content.length / 1024).toFixed(0)} KB)`);
        return content;
      }
    } catch {
      // skip failed chunks
    }
  }
  throw new Error('Chunk containing seed logic not found');
}

// ─── Step 4: Extract & Decode the Seed Module ───────────────────────────────────

/**
 * Extracts the webpack module containing the seed logic from the large chunk,
 * then decrypts the RC4 obfuscated string table to get the seed map values.
 *
 * Anchor: Uses known seed value literals (e.g., "9402684" or other numeric strings)
 * to locate the seed module, rather than "seedMap" (which appears in React component code).
 */
function extractSeedMap(chunkContent) {
  console.log('[4/5] Extracting and decrypting seed module...');

  // -- 4a: Locate seed module --
  // Search for i.d(t,{i:()=>FUNC}) export marker, which is near the seed values
  // First find known seed value literals like "9402684" or other numeric strings as an anchor
  const knownSeedPatterns = ['"9402684"', '"74670526"', '"38325553"', '"1289559305"'];
  let anchorIdx = -1;
  let anchorPattern = '';
  for (const p of knownSeedPatterns) {
    const idx = chunkContent.indexOf(p);
    if (idx !== -1) { anchorIdx = idx; anchorPattern = p; break; }
  }
  if (anchorIdx === -1) {
    // Fallback: Search for RC4 module export pattern + SHA-1 hashing logic combination
    // Find i.d exports near modules containing "SHA-1" or sha1
    const sha1Idx = chunkContent.indexOf('"sha1"');
    if (sha1Idx !== -1) anchorIdx = sha1Idx;
    else throw new Error('Failed to locate seed module (known seed value or SHA-1 reference not found)');
  }
  console.log(`    Anchor: ${anchorPattern || '"sha1"'} @ position ${anchorIdx}`);

  // Search backwards from the anchor for the nearest i.d(t,{i:()=>...}) export marker
  const backSearchStart = Math.max(0, anchorIdx - 10000);
  const backRegion = chunkContent.substring(backSearchStart, anchorIdx);
  const exportMatches = [...backRegion.matchAll(/i\.d\(t,\{i:\(\)=>(\w+)\}\)/g)];
  if (exportMatches.length === 0) throw new Error('Webpack module export marker not found');
  const lastExport = exportMatches[exportMatches.length - 1];
  const exportAbsIdx = backSearchStart + lastExport.index;
  console.log(`    Export marker: i.d(t,{i:()=>${lastExport[1]}}) @ position ${exportAbsIdx}`);

  // -- 4b: Trace back from the export marker to find the module start --
  // Webpack modules format: NUMBER:(e,t,i)=>{ ... }
  let moduleStart = exportAbsIdx;
  for (let j = exportAbsIdx - 1; j > Math.max(0, exportAbsIdx - 15000); j--) {
    // Match "number:(e,t,i)" or "number:(e,t,i)=>"
    const slice = chunkContent.substring(j, j + 15);
    if (/^\d+:\(e,t,i/.test(slice)) {
      moduleStart = j;
      break;
    }
  }

  // -- 4c: Find module end (matching braces) --
  let braceCount = 0, started = false, moduleEnd = exportAbsIdx;
  for (let j = moduleStart; j < Math.min(chunkContent.length, moduleStart + 50000); j++) {
    if (chunkContent[j] === '{') { braceCount++; started = true; }
    if (chunkContent[j] === '}') { braceCount--; }
    if (started && braceCount === 0) { moduleEnd = j + 1; break; }
  }

  const moduleCode = chunkContent.substring(moduleStart, moduleEnd);
  console.log(`    Module size: ${moduleCode.length} bytes`);

  // Verify the extracted module contains key content
  if (!moduleCode.includes('i.d(t,')) {
    throw new Error('Extracted module does not contain export marker, localization might be wrong');
  }

  // -- 4d: Extract string table --
  const arrayMatch = moduleCode.match(/function\s+\w+\(\)\s*\{\s*let\s+\w+\s*=\s*\[([\s\S]*?)\];\s*return/);
  if (!arrayMatch) throw new Error('String table array not found');

  // Use JS native Parser to extract string array, avoiding regex boundary issues
  let stringArray = [];
  try {
    stringArray = new Function('return [' + arrayMatch[1] + ']')();
  } catch (err) {
    throw new Error('Failed to parse string table array: ' + err.message);
  }

  console.log(`    String table: ${stringArray.length} items`);

  // -- 4e: Extract RC4 function base offset --
  const offsetMatch = moduleCode.match(/function\s+(\w+)\(e,\s*t\)\s*\{\s*e\s*-=\s*(\d+)/);
  if (!offsetMatch) throw new Error('RC4 function offset value not found');
  const decryptFuncName = offsetMatch[1];
  const baseOffset = parseInt(offsetMatch[2], 10);
  console.log(`    RC4 Function: ${decryptFuncName}(), Offset: ${baseOffset}`);

  // -- 4f: Extract rotation target value --
  const rotationMatch = moduleCode.match(/===\s*(\d{4,10})\)\s*break/);
  if (!rotationMatch) throw new Error('Rotation target value not found');
  const rotationTarget = parseInt(rotationMatch[1], 10);
  console.log(`    Rotation target value: ${rotationTarget}`);

  // -- 4g: Extract rotation formula --
  const formulaRegion = moduleCode.match(/for\s*\(;;\)\s*try\s*\{([\s\S]*?)===\s*\d+\)\s*break/);
  if (!formulaRegion) throw new Error('Rotation formula region not found');
  const formulaCode = formulaRegion[1];

  // -- 4h: Implement RC4 decryption --
  const currentArray = [...stringArray];

  // Base64 decoding (Custom alphabet: lowercase first)
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

  // RC4 Decryption
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

  // Complete implementation of a() function (with caching)
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

  // -- 4i: Execute string table rotation --
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
      console.log(`    ✓ String table rotation complete (${attempt} rotations)`);
      rotated = true;
      break;
    }
    currentArray.push(currentArray.shift());
  }
  if (!rotated) throw new Error('String table rotation failed');

  // -- 4j: Extract properties of the seed map configuration object --
  let objVarName = '';
  let objCode = '';
  // find "9402684" literal or uGHKa
  const seedPattern = moduleCode.includes('"9402684"') ? '"9402684"' : (moduleCode.includes('uGHKa') ? 'uGHKa' : null);
  if (!seedPattern) throw new Error('Seed map configuration object anchor not found');
  const anchorIdx2 = moduleCode.indexOf(seedPattern);
  
  // Trace back to find object variable name "let o={" or ",o={"
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
  if (!objVarName) throw new Error('Failed to locate configuration object start position');
  
  // Match closing '}'
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

  // Decode all property values in the object
  const propRegex = /(\w+)\s*:\s*(?:(\w+)\((\d+),\s*"([^"]+)"\)(?:\s*\+\s*(?:(\w+)\((\d+),\s*"([^"]+)"\)|"([^"]*)"))?|"([^"]*)"|(function\([^)]*\)\s*\{[^}]*\}))/g;
  const objProps = {};
  let pm;
  while ((pm = propRegex.exec(objCode)) !== null) {
    const propName = pm[1];
    if (pm[9] !== undefined) {
      objProps[propName] = pm[9]; // String literal
    } else if (pm[10]) {
      continue; // Function value, skip
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

  console.log('\n    Decoded configuration object properties:');
  for (const [k, v] of Object.entries(objProps)) {
    if (typeof v === 'string' && v.length < 50) {
      console.log(`      ${k} = "${v}"`);
    }
  }

  // -- 4k: Extract seed map assignment logic --
  const seedMapEntries = {};

  // Extract local variable string table (e.g., let r="pyfM", s="N#QU")
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

  // Match l[o.PROP1] = o.PROP2
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

  // Support a(IDX, KEY) format, where KEY can be a literal or a variable
  // Match l[o.PROP] = o[a(IDX, KEY_VAR)] or l[o[a(IDX, KEY_VAR)]] = o[a(IDX, KEY_VAR)]
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

  // Verify extraction results
  if (Object.keys(seedMapEntries).length === 0) {
    throw new Error('Failed to extract any seed map entries');
  }

  // -- 4l: Detect computeSeedMap operation logic --
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
    throw new Error('seedMapStartingState not found in src/index.js');
  }

  const newSeedMap = formatSeedMap(seedMap);
  content = content.replace(seedMapRegex, newSeedMap);

  await writeFile(indexPath, content, 'utf-8');
  console.log(`    ✓ Updated src/index.js`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const shouldUpdate = args.includes('--update');

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   VRoid Hub Seed Map Auto-Extractor          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    // Step 1: Get build ID
    const buildId = await getBuildId();

    // Step 2: Get chunk list
    const chunkPaths = await getChunkPaths(buildId);

    // Step 3: Find target chunk
    const chunkContent = await findSeedChunk(chunkPaths);

    // Step 4: Extract and decrypt seed map
    const { seedMap, sopOperation, normalOperation } = extractSeedMap(chunkContent);

    // Step 5: Output results
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║              Extraction Results              ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    console.log(formatSeedMap(seedMap));
    console.log(`\ncomputeSeedMap operation logic:`);
    console.log(`  s=op path: ${sopOperation} (value ${sopOperation === 'XOR' ? '^' : '+'} hashInt)`);
    console.log(`  Normal path:  ${normalOperation} (value + modelId)`);

    // Compare with current code
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
        console.log('\n✅ seedMapStartingState in src/index.js is up to date, no update needed.');
      } else {
        console.log('\n⚠  seedMapStartingState in src/index.js needs to be updated:');
        console.log(`   Current: ${JSON.stringify(currentEntries)}`);
        console.log(`   Latest: ${JSON.stringify(seedMap)}`);

        if (shouldUpdate) {
          await updateIndexJs(seedMap);
        } else {
          console.log('\n   Run node extract_seeds.mjs --update to update automatically');
        }
      }
    }

    console.log('\nDone.');
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
