#!/usr/bin/env node
import { readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SECTION = /^\[([a-z_]+)\]$/;
const BUILTINS = ['direct', 'proxy', 'reject', 'reject-tinygif', 'reject-img', 'reject-dict', 'reject-200'];

function active(line) {
  return Boolean(line.trim()) && !/^(#|;|\/\/)/.test(line.trimStart());
}

export function parseProfile(text) {
  const sections = { '': [] };
  let current = '';
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const match = line.trim().match(SECTION);
    if (match) {
      current = match[1];
      if (Object.hasOwn(sections, current)) throw new Error('上游包含重复分节');
      sections[current] = [];
    } else {
      sections[current].push(line);
    }
  }
  if (['general', 'dns', 'policy', 'filter_local'].some(key => !Object.hasOwn(sections, key))) {
    throw new Error('配置缺少必要分节，或下载结果不是 QuanX 配置');
  }
  return sections;
}

function render(sections) {
  return Object.entries(sections)
    .flatMap(([section, lines]) => [...(section ? [`[${section}]`] : []), ...lines])
    .map(line => line.trimEnd()).join('\n') + '\n';
}

function lineId(section, line) {
  if (!active(line)) return null;
  if (section === 'policy') return line.slice(line.indexOf('=') + 1).split(',')[0].trim();
  if (['filter_remote', 'rewrite_remote'].includes(section)) return line.split(',')[0].trim();
  if (section === 'dns') {
    const match = line.match(/^\s*server\s*=\s*(\/[^/]+\/)/);
    if (match) return `server=${match[1]}`;
  }
  return line.replace(/\s+/g, '');
}

export function checkPublic(text) {
  for (const line of text.split(/\r?\n/)) {
    if (active(line) && /(?:^|[?&,\s])(?:p12|passphrase|password|passwd|token|secret|authorization)\s*=/i.test(line)) {
      throw new Error('公开配置包含敏感凭据；请将订阅与证书留在本机');
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSettings(settings, sections) {
  const allowed = ['upstream_url', 'config_url', 'append_values', 'set_values', 'prepend_lines'];
  if (!isObject(settings) || Object.keys(settings).some(key => !allowed.includes(key))) {
    throw new Error('私人配置包含未知设置');
  }
  for (const key of ['upstream_url', 'config_url']) {
    if (typeof settings[key] !== 'string' || !settings[key].startsWith('https://')) {
      throw new Error(`${key} 必须使用 HTTPS 链接`);
    }
  }
  for (const mode of ['append_values', 'set_values', 'prepend_lines']) {
    const groups = settings[mode] ?? {};
    if (!isObject(groups)) throw new Error(`${mode} 必须是对象`);
    for (const [section, values] of Object.entries(groups)) {
      if (!section || !Object.hasOwn(sections, section)) throw new Error('私人配置引用了不存在的分节');
      if (['server_remote', 'server_local'].includes(section)) throw new Error('敏感节点配置应留在本机');
      let items = values;
      if (mode !== 'prepend_lines') {
        if (!isObject(values)) throw new Error(`${mode} 的分节必须是对象`);
        if (Object.keys(values).some(key => !/^[a-z_-]+$/.test(key))) throw new Error('设置键无效');
        items = Object.values(values);
        if (mode === 'append_values') {
          if (items.some(value => !Array.isArray(value))) throw new Error('追加设置必须是列表');
          items = items.flat();
        }
      }
      if (!Array.isArray(items) || items.some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))) {
        throw new Error('设置值必须是非空的单行字符串');
      }
      if (mode === 'prepend_lines' && items.some(value => SECTION.test(value.trim()))) {
        throw new Error('覆盖行不能包含分节标题');
      }
    }
  }
  for (const [section, values] of Object.entries(settings.append_values ?? {})) {
    if (Object.keys(values).some(key => Object.hasOwn(settings.set_values?.[section] ?? {}, key))) {
      throw new Error('同一设置不能同时替换和追加');
    }
  }
}

export function mergeProfile(upstream, settings, privateRules) {
  const sections = parseProfile(upstream);
  validateSettings(settings, sections);
  checkPublic(upstream);
  checkPublic(JSON.stringify(settings).replaceAll('"', ' '));
  checkPublic(privateRules);
  for (const mode of ['set_values', 'append_values']) {
    for (const [section, values] of Object.entries(settings[mode] ?? {})) {
      for (const [key, value] of Object.entries(values)) {
        const pattern = new RegExp(`^\\s*${key}\\s*=`);
        const matches = sections[section].flatMap((line, index) => pattern.test(line) ? [index] : []);
        let merged = value;
        if (mode === 'append_values') {
          const existing = matches.flatMap(index => {
            const line = sections[section][index];
            return line.slice(line.indexOf('=') + 1).split(',').map(item => item.trim()).filter(Boolean);
          });
          merged = [...new Set([...existing, ...value])].join(', ');
        }
        const position = matches[0] ?? 0;
        sections[section] = sections[section].filter((_, index) => !matches.includes(index));
        sections[section].splice(position, 0, `${key} = ${merged}`);
      }
    }
  }
  for (const [section, additions] of Object.entries(settings.prepend_lines ?? {})) {
    if (section === 'filter_local' && additions.some(line => /^\s*final\s*,/.test(line))) {
      throw new Error('私人前置规则不能包含 final');
    }
    const identities = additions.filter(active).map(line => lineId(section, line));
    if (identities.length !== new Set(identities).size) throw new Error('私人覆盖包含重复标识');
    sections[section] = [...additions, ...sections[section].filter(line => !identities.includes(lineId(section, line)))];
  }
  const policies = new Set([...BUILTINS, ...sections.policy.filter(active).map(line => lineId('policy', line))]);
  const rules = [...privateRules.split(/\r?\n/), ...(settings.prepend_lines?.filter_local ?? [])];
  for (const rule of rules.filter(active)) {
    const parts = rule.split(',').map(part => part.trim());
    if (parts.length < 3 || parts[0] === 'final') throw new Error('私人分流必须是完整规则且不能包含 final');
    if (!policies.has(parts[2])) throw new Error('私人规则引用未定义策略');
  }
  for (const resource of settings.prepend_lines?.filter_remote ?? []) {
    const match = resource.match(/(?:^|,)\s*force-policy\s*=\s*([^,]+)/);
    if (match && !policies.has(match[1].trim())) throw new Error('私人资源引用未定义策略');
  }
  const header = sections[''];
  for (const [key, value] of [['ConfigURL', settings.config_url], ['ConfigName', '墨鱼配置 + 私人覆盖']]) {
    const pattern = new RegExp(`^//\\s*@${key}\\b`);
    const index = header.findIndex(line => pattern.test(line));
    if (index >= 0) header[index] = `// @${key} ${value}`;
    else header.unshift(`// @${key} ${value}`);
  }
  const result = render(sections);
  checkPublic(result);
  return result;
}

export function preserveLocal(publicProfile, localProfile) {
  const result = parseProfile(publicProfile);
  const local = parseProfile(localProfile);
  for (const section of ['server_local', 'server_remote']) result[section] = local[section] ?? [];
  const keys = /^\s*(?:p12|passphrase)\s*=/;
  result.mitm = [...(result.mitm ?? []).filter(line => !keys.test(line)), ...(local.mitm ?? []).filter(line => keys.test(line))];
  result[''] = result[''].filter(line => !/^\/\/\s*@ConfigURL\b/.test(line));
  return render(result);
}

async function main() {
  const { values } = parseArgs({ options: {
    'upstream-file': { type: 'string' },
    'local-profile': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法：node scripts/build-profile.mjs [--upstream-file 上游文件] [--local-profile 本机完整配置]');
    return;
  }
  const settings = JSON.parse(await readFile(join(ROOT, 'personal.json'), 'utf8'));
  let upstream;
  if (values['upstream-file']) {
    upstream = await readFile(values['upstream-file'], 'utf8');
  } else {
    const response = await fetch(settings.upstream_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuanXProfileBuilder/1.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`下载上游失败：HTTP ${response.status}`);
    if (!response.url.startsWith('https://')) throw new Error('上游重定向到了非 HTTPS 地址');
    upstream = await response.text();
  }
  let result = mergeProfile(upstream, settings, await readFile(join(ROOT, 'selfProxy.conf'), 'utf8'));
  let output = join(ROOT, 'QuantumultX.conf');
  if (values['local-profile']) {
    result = preserveLocal(result, await readFile(values['local-profile'], 'utf8'));
    output = join(ROOT, '.local', 'QuantumultX.conf');
  }
  await mkdir(dirname(output), { recursive: true });
  const tempDir = await mkdtemp(join(dirname(output), '.build-profile-'));
  try {
    const tempPath = join(tempDir, 'QuantumultX.conf');
    await writeFile(tempPath, result, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  console.log(`已生成：${output}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`生成失败：${error.message}`);
    process.exitCode = 1;
  });
}
