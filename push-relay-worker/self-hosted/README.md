# 自建 Relay 部署

`airsim-relay.service` 启动本机 workerd，`airsim-apns.service` 负责到 Apple 的 HTTP/2 请求。默认 HTTP 和 WebSocket 共用 `127.0.0.1:8787`；定时清理使用 `127.0.0.1:8789`，证书代理使用 `127.0.0.1:8790`。反向代理只需连接 8787，并支持 WebSocket 升级。配置外部 HTTPS 入口时，向 Relay 传递固定的外部 Host 及可信的 `X-Forwarded-Proto: https`，使客户端取得正确的 WSS 媒体地址。

## 首次安装

安装脚本适用于使用 systemd 的 Linux，需要 root、OpenSSL、curl、tar、xz 和 SHA-256 校验工具。源码配套的运行时为 Node.js 22 和 workerd 1.20261103.1。先在独立的私有暂存目录准备这些文件。

| 文件 | 内容 |
| --- | --- |
| `source.tar.gz` | 此仓库的源码包，解压后的顶层应直接包含 `push-relay-worker/`。可在仓库根目录用 `git archive --format=tar.gz --output=/absolute/path/to/source.tar.gz HEAD` 生成。 |
| `node.tar.xz` | 与系统 CPU 架构匹配的官方 Node.js Linux 二进制包，解包并移除第一层目录后有 `bin/node`。 |
| `workerd.tgz` | 匹配 CPU 架构、包含原生 `bin/workerd` 的 workerd 包。例如 x86-64 选择相应版本的 `@cloudflare/workerd-linux-64` 平台包。 |
| `config.json` | 以 `config.example.json` 为起点，填入自己的 Bundle ID、管理令牌和证书路径。为管理令牌生成独立的高熵随机值。 |
| `SHA256SUMS` | 上述四个暂存文件的 SHA-256 清单，文件名与表中一致。先验证下载的软件来源和发行校验信息，再生成本地清单。 |

先创建服务账户 `airsim-relay` 和同名组，按[证书配置](APNS-CERTIFICATE-DEPLOYMENT.md)安装证书并确保账户能读取。安装脚本会在启动服务前将私有配置安装到 `/etc/airsim-relay/config.json`，并创建状态目录。从此目录运行以下命令，将路径替换为自己的私有暂存目录。

```sh
sudo bash install-ecs.sh /absolute/path/to/private-stage
sudo systemctl enable --now airsim-apns-monitor.timer
```

脚本面向首次安装，会检查现有安装目录并在检测到已安装服务时退出。证书、真实配置、外部入口及备份由部署者持有。未使用外部 Web Push 通知服务时，请留空 `WEBPUSH_TOKEN`；启用后需要另行提供与当前接口兼容的本机通知服务。

## 健康检查与端到端验收

```sh
systemctl is-active airsim-relay.service airsim-apns.service
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
curl --fail --silent --show-error http://127.0.0.1:8790/healthz
sudo -u airsim-relay /opt/airsim-relay/node/bin/node /opt/airsim-relay/current/push-relay-worker/self-hosted/smoke.mjs
```

smoke 使用管理令牌创建并删除本次的临时设备，验证心跳、鉴权、重复命令及双向二进制音频数据。默认访问回环；如要验证真实反代，可在同一机器为命令设置 `AIRSIM_SMOKE_ORIGIN` 为自己的外部 HTTPS 地址。使用其他测试配置时可设置 `AIRSIM_SMOKE_CONFIG`。APNs 代理健康检查验证本地证书配置；实际送达到设备须分别用对应环境的新鲜 Token 测普通通知和 VoIP 来电。

## 对外 HTTPS 与运维

已有 HTTPS/WSS 入口可以继续使用。随附的独立 Nginx/IP 入口和 HTTPS 续期单元是另一种部署方式。使用时须自行提供 `/usr/sbin/nginx`、证书、配置中的 Nginx 用户、缓存和 ACME challenge 目录，并确认 80、443 端口可用。可用 `node configure-ip.mjs <公网IPv4> <nginx.conf路径> [--tls]` 生成示例。续期单元预期 Certbot 位于 `/opt/airsim-relay/certbot/bin/certbot`，并使用名为 `airsim-relay-ip` 的证书。首次签发和续期后的 Nginx reload hook 由部署者配置。定时清理单元使用系统 curl 访问私有维护端口，可用 `systemctl list-timers 'airsim-*'` 查看计划。

服务代码在 `/opt/airsim-relay/releases/` 下分版本保存，由 `/opt/airsim-relay/current` 选择版本；设备数据在 `/var/lib/airsim-relay/`，配置在 `/etc/airsim-relay/`。更新前在私有位置做一致备份，并先在隔离状态目录跑测试。空闲时原子切换 current，随后重启受影响的服务，再检查健康接口、已配对设备的心跳和双向媒体。若启动或协议验证失败，将 current 切回原目标并重启同一组服务。数据格式发生变化时，还需按版本确认备份恢复方案。
