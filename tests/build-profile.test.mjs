import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeProfile, preserveLocal } from '../scripts/build-profile.mjs';

const BASE = `// @ConfigName 墨鱼配置
// @ConfigURL https://example.com/upstream.conf
[general]
dns_exclusion_list = upstream.example
server_check_timeout = 3000
[dns]
no-ipv6
server=223.5.5.5
[policy]
static=默认策略, direct, proxy
[filter_remote]
https://example.com/ads.list, tag=广告, force-policy=reject
[filter_local]
geoip, cn, direct
final, 默认策略
[mitm]
hostname = *.example.com
`;

function settings() {
  return {
    upstream_url: 'https://example.com/upstream.conf',
    config_url: 'https://example.com/personal.conf',
    append_values: { general: { dns_exclusion_list: ['local.adguard.org'] } },
    prepend_lines: {
      policy: ['static=智慧医疗, direct, proxy, reject'],
      filter_remote: ['https://example.com/self.list, tag=自用, enabled=true'],
      filter_local: ['host, local.adguard.org, direct'],
    },
  };
}

test('拒绝未知设置', () => {
  assert.throws(() => mergeProfile(BASE, { ...settings(), append_value: {} }, ''), /未知/);
});

test('拒绝错误的追加列表类型', () => {
  const config = settings();
  config.append_values.general.dns_exclusion_list = 'local.adguard.org';
  assert.throws(() => mergeProfile(BASE, config, ''), /列表/);
});

test('拒绝 HTML 上游', () => {
  assert.throws(() => mergeProfile('<html>Service Unavailable</html>', settings(), ''), /配置/);
});

test('拒绝不存在的分节', () => {
  const config = settings();
  config.prepend_lines.polciy = ['static=智慧医疗, direct'];
  assert.throws(() => mergeProfile(BASE, config, ''), /分节/);
});

test('拒绝公开证书凭据', () => {
  assert.throws(() => mergeProfile(`${BASE}p12=test-only-certificate\n`, settings(), ''), /敏感/);
});

test('拒绝私人订阅分节', () => {
  const config = settings();
  config.prepend_lines.server_remote = ['https://example.com/private-sub'];
  assert.throws(() => mergeProfile(`${BASE}[server_remote]\n`, config, ''), /敏感/);
});

test('拒绝未定义的私人策略', () => {
  assert.throws(() => mergeProfile(BASE, settings(), 'host, example.com, 不存在的策略\n'), /未定义/);
});

test('拒绝提前添加 final', () => {
  const config = settings();
  config.prepend_lines.filter_local = ['final, direct'];
  assert.throws(() => mergeProfile(BASE, config, ''), /final/);
});

test('DNS 排除列表保留上游新增域名且不重复键', () => {
  const result = mergeProfile(BASE.replace('upstream.example', 'upstream.example, new.example'), settings(), '');
  assert.ok(result.includes('dns_exclusion_list = upstream.example, new.example, local.adguard.org'));
  assert.equal(result.split('dns_exclusion_list =').length - 1, 1);
});

test('私人资源和本地规则前置，final 保持末尾', () => {
  const result = mergeProfile(BASE, settings(), 'host-suffix, njzhyl.cn, 智慧医疗\n');
  assert.ok(result.indexOf('https://example.com/self.list') < result.indexOf('https://example.com/ads.list'));
  assert.ok(result.indexOf('host, local.adguard.org, direct') < result.indexOf('geoip, cn, direct'));
  assert.ok(result.includes('final, 默认策略\n[mitm]'));
});

test('同名策略组替换且不重复', () => {
  const config = settings();
  config.prepend_lines.policy = ['static=默认策略, proxy, direct'];
  const result = mergeProfile(BASE, config, '');
  assert.equal(result.split('static=默认策略').length - 1, 1);
  assert.ok(result.includes('static=默认策略, proxy, direct'));
});

test('标量设置替换且不重复键', () => {
  const config = settings();
  config.set_values = { general: { server_check_timeout: '5000' } };
  const result = mergeProfile(BASE, config, '');
  assert.ok(result.includes('server_check_timeout = 5000'));
  assert.equal(result.split('server_check_timeout =').length - 1, 1);
});

test('更新配置地址且重复合并结果一致', () => {
  const once = mergeProfile(BASE, settings(), '');
  assert.ok(once.includes('// @ConfigURL https://example.com/personal.conf'));
  assert.ok(!once.includes('// @ConfigURL https://example.com/upstream.conf'));
  assert.equal(mergeProfile(once, settings(), ''), once);
});

test('同 URL 重写保留关闭状态', () => {
  const config = settings();
  config.prepend_lines.rewrite_remote = ['https://example.com/rewrite.conf, enabled=false'];
  const result = mergeProfile(`${BASE}[rewrite_remote]\nhttps://example.com/rewrite.conf, enabled=true\n`, config, '');
  assert.equal(result.split('https://example.com/rewrite.conf').length - 1, 1);
  assert.ok(result.includes('https://example.com/rewrite.conf, enabled=false'));
});

test('替换同域名 DNS，保留通用服务器', () => {
  const config = settings();
  config.prepend_lines.dns = ['server=/example.com/system'];
  const upstream = BASE.replace('server=223.5.5.5', 'server=223.5.5.5\nserver = /example.com/119.29.29.29');
  const result = mergeProfile(upstream, config, '');
  assert.ok(result.includes('server=223.5.5.5'));
  assert.ok(result.includes('server=/example.com/system'));
  assert.ok(!result.includes('/example.com/119.29.29.29'));
});

test('本机模式保留凭据，公开结果不含凭据', () => {
  const publicProfile = mergeProfile(`${BASE}[server_remote]\nhttps://example.com/public\n[server_local]\n`, settings(), '');
  const local = BASE.replace('hostname = *.example.com', 'hostname = *.example.com\npassphrase=test-only\np12=test-only')
    + '[server_remote]\nhttps://example.com/local?token=test-only\n[server_local]\nshadowsocks=example.com:443, password=test-only\n';
  const result = preserveLocal(publicProfile, local);
  for (const value of ['p12=test-only', 'token=test-only', 'password=test-only']) assert.ok(result.includes(value));
  assert.ok(!result.includes('https://example.com/public'));
  assert.ok(!result.includes('@ConfigURL'));
  assert.ok(!publicProfile.includes('test-only'));
});

test('生成时清理上游注释行尾空格', () => {
  const result = mergeProfile(BASE.replace('[general]', '# 上游历史注释  \n[general]'), settings(), '');
  assert.ok(result.includes('# 上游历史注释\n'));
  assert.ok(!/[\t ]+$/m.test(result));
});
