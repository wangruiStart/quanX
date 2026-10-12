# 私人 QuanX 配置

将最新墨鱼配置与 `personal.json` 合并，生成自己的 `QuantumultX.conf`。不需要每次更新后重新手改 DNS、策略组和资源开关。使用 JavaScript，Node.js 22+ 即可运行，无第三方依赖。

QuanX 的远程分流和重写资源只管理对应资源，不能用一个资源链接覆盖 DNS 和策略组。因此，需要使用这里生成的完整配置链接。

## 文件用途

| 文件 | 维护内容 |
| --- | --- |
| `selfProxy.conf` | 私人域名与 IP 分流，继续作为远程资源引用 |
| `personal.json` | DNS、策略组、本地优先规则、远程分流及重写开关 |
| `QuantumultX.conf` | 生成的公开配置，不直接修改 |
| `.local/` | 本机完整配置、订阅与证书；Git 忽略此目录 |
| `kanlixiang.conf` / `youtubeAds.conf` | 原有资源文件，本次没有新增启用引用 |

本次以 QuanX 当前打开的配置为依据，保留：

- AdGuard 的 `dns_exclusion_list` 排除与 `host, local.adguard.org, direct` 本地规则。
- 源鑫保险的系统 DNS、自定义 `colombianightclub.com` DNS、`no-system` 和 `114.114.114.114`。
- `Shawn`、`智慧医疗` 策略组，六个自动测速组的 900 秒检测间隔。
- 当前本地私人分流及自用远程分流。私人资源放在上游资源前面。
- 广告分流关闭；重写中保留墨鱼专属 VIP、豆瓣开启，其他当前上游重写关闭，以延续当前配置删除或关闭资源的选择。

上游新增的资源仍采用上游默认设置。如不需要，添加对应覆盖行并设 `enabled=false`。旧配置的失效 gist AI 链接没有迁移，使用墨鱼最新 AI 链接；保留当前 AI 资源没有 `force-policy` 的行为。通用策略组沿用最新上游定义。

## 日常维护

在项目目录执行：

```sh
node scripts/build-profile.mjs
node --test
```

第一条命令获取最新墨鱼配置，再重新应用私人设置。下载、校验或合并失败时，不会覆盖现有生成文件。

私人覆盖的格式：

- `append_values`：逗号列表追加并去重。DNS 排除列表会保留墨鱼以后新增的域名。
- `set_values`：替换一个标量设置。例如 `{"general": {"server_check_timeout": "5000"}}`。
- `prepend_lines`：前置私人配置。同名策略组、同 URL 资源和同域名 DNS 映射会替换上游定义；其他上游内容保留。

新分流写到 `selfProxy.conf`；新增策略必须先在 `personal.json` 的 `policy` 中定义。远程规则中不要写 `final`，最终兜底由完整配置保留。需要域名 MITM 时，可在 `append_values.mitm.hostname` 追加域名；证书本身不能写入 `personal.json`。

## 发布后使用自己的链接

仓库发布这些文件后，完整配置地址为：

```text
https://raw.githubusercontent.com/wangruiStart/quanX/main/QuantumultX.conf
```

生成文件的 `@ConfigURL` 指向这个地址。它是完整配置导入地址，不能放进 `[filter_remote]` 或 `[rewrite_remote]`。当前本地生成不代表该链接已经发布。

仓库工作流支持两种更新方式：修改私人源文件并推送时自动生成；墨鱼有新版时，在 GitHub Actions 中手动运行“更新私人 QuanX 配置”。没有设置定时任务。首次推送后，确认工作流成功再使用链接。

## 本机订阅与证书

公开配置不含你的节点订阅、节点密码、`p12` 或 `passphrase`。公开模板保留上游作者的公开临时订阅。

**完整配置导入可能替换节点订阅与证书字段，不承诺 QuanX 自动保留。** 初次导入前备份当前配置，并将订阅和证书字段恢复到本机。希望每次更新都自动保留这些字段时，使用下面的本机生成方式：

1. 从 QuanX 导出当前完整配置，存为项目的 `.local/current.conf`。该文件只保存在本机。
2. 执行 `node scripts/build-profile.mjs --local-profile .local/current.conf`。
3. 导入 `.local/QuantumultX.conf`。它保留本机 `[server_local]`、`[server_remote]`、MITM `p12` 与 `passphrase`。

后续仍执行第 2 步即可。更换订阅或证书后，重新导出 `.local/current.conf`。本机输出移除 `@ConfigURL`，避免直接用公开模板更新导致本机凭据丢失。此模式没有把其他本机设置重新迁移，DNS、策略组和重写以 `personal.json` 为准。

不要把完整配置导出文件放到项目根目录或提交 Git。自动检查会拒绝常见凭据字段，但不能识别所有放在 URL 路径中的订阅密钥；公开前仍需核对私人资源链接。

## 离线验证

```sh
node scripts/build-profile.mjs --upstream-file /path/to/QuantumultX.conf
```

上游参考：[墨鱼配置](https://ddgksf2013.top/Profile/QuantumultX.conf)、[QuanX 官方示例](https://github.com/crossutility/Quantumult-X/blob/master/sample.conf)。保留上游作者信息和注释。
