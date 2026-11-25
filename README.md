# AirSIM 自建 Relay

在自己的 Linux 服务器上运行 AirSIM 的云端中继。安卓和 iPhone 可以通过局域网或 WireGuard 隧道交换通话、短信事件和控制命令，通过 WebSocket 中继通话音频。Relay 在本机保存配对和设备状态，通过 HTTP/2 向 Apple 发送普通通知和 PushKit 来电推送。可直接使用 IP 地址，无需注册域名或开通 Cloudflare 服务。

## 一行安装

在具备 Bash、curl、Docker Engine 和 Docker Compose v2 的 Linux 服务器上运行以下命令。执行账户需要能操作 Docker 并写入安装目录。默认目录为 `/opt/airsim-relay-standalone`。支持 Linux x86-64 和 arm64 的镜像构建，首次安装需能访问 GitHub、Docker Hub、npm 以及基础镜像使用的软件包源。

```sh
curl -fsSL https://raw.githubusercontent.com/Milk-lpy/airsim-relay/main/install.sh | bash -s -- --bind auto-private
```

`auto-private` 选择服务器默认 IPv4 路由使用的私网地址。如果手机经 WireGuard 访问，建议把 `auto-private` 换成服务器实际的隧道 IP。手机端需能路由到所选地址。云服务商的公网地址映射和防火墙也会影响谁能访问这个端口。在已有 Relay 的主机上并行安装时，请为新实例选一个空闲的地址和端口组合，先用测试设备验证。

### 打开配置向导

1. 安装完成后，终端会给出 SSH 转发命令和一条带令牌的私有链接。在自己的电脑上建立 SSH 隧道，例如 `ssh -N -L 18181:127.0.0.1:18181 用户@服务器地址`，保留这个终端窗口。
2. 在这台电脑的浏览器打开安装器给出的链接。管理页面只发布在服务器回环地址。配置令牌能更换服务凭据，请将链接作为密码保存。
3. 在「Relay 入口」确认手机实际访问的 IP 或域名。安装时选定的非回环地址会自动填入。服务使用 HTTPS/WSS 端口 `18788`。可自动生成专用根证书和带 IP 或域名的服务器证书，也可上传已有 HTTPS 证书链与私钥。
4. 在「Apple 推送」填入 iOS App 的 Bundle ID，选择与该安装包的 `aps-environment` 匹配的 Sandbox 或 Production，再导入苹果签发的 APNs Provider 证书。支持带导出密码的 P12，以及 PEM 证书和私钥。若普通通知和 VoIP 分别授权，可另外填入 VoIP 的 PEM 证书与私钥。向导会验证证书链、有效期、私钥、环境及普通和 VoIP 的 Topic。
5. 点击「验证配置」，通过后再应用并启动。使用向导生成 HTTPS 证书时，从完成页下载公开根证书，在客户端配置相应的信任。iPhone 手动安装根证书后需开启完全信任。安卓版本须支持该 CA，部分 App 会限定受信任的证书。随后将两端 Relay 地址设置为 `https://所选地址:18788` 并运行 AirSIM 自检。

「运行中」说明本机服务已启动。验证真实推送还需对应环境的设备 Token，在 iPhone 锁屏时分别触发一次短信和来电。验证期间部署者无需向 GitHub 提供证书、私钥、设备信息或配置令牌。

## 更新、备份与恢复

- **更新**　在同一安装目录重新运行安装命令。安装器沿用原设备数据卷、配置和令牌，构建成功才切换容器。若原 Relay 正在运行，升级还会检查新 Relay 能否运行；检查失败会恢复旧容器。更新会短暂中断服务，请避开通话。需要固定版本时，下载链接里的 `main` 和安装参数 `--ref` 均使用同一个提交 SHA。
- **回到指定版本**　可再次运行安装命令并追加 `--ref 已验证可用的旧提交SHA`，例如上一次安装记录中的版本；安装位置仍须相同。
- **修改配置**　重新打开配置向导。修改主机、Bundle ID 或环境时可以继续使用已保存的证书。先校验、再应用；新配置启动失败会尝试恢复原配置。Bundle ID 和推送环境仍须匹配证书及客户端。
- **找回向导令牌**　在服务器执行 `cd /opt/airsim-relay-standalone/current && docker compose exec -T relay cat /data/setup-token`，经 SSH 转发打开 `http://127.0.0.1:18181/`，填入令牌。
- **查看状态**　在上述 `current` 目录运行 `docker compose ps` 和 `docker compose logs --tail 80 relay`。容器健康检查反映向导的可访问性，实际 Relay 运行状态见向导。
- **存储**　Compose 命名卷挂载为 `/data`，包含设备数据库、配置、证书、私钥和令牌。安装目录决定 Compose 项目和卷名。迁移到另一台主机或另一个目录时先完整备份；删除该卷将丢失配对数据。
- **备份与恢复**　在 `current` 目录执行下面的备份命令，它会短暂停止 Relay 获取一致快照。备份包含私钥，请妥善保管。恢复时先在目标上运行安装器并打开同一安装目录，确认目标卷为空且尚未配置，再通过第二段命令导入。最后回到向导核对状态。

```sh
(cd /opt/airsim-relay-standalone/current && umask 077 && docker compose stop relay && \
  { docker compose run --rm -T --no-deps --entrypoint tar relay -C /data -czf - . > "$HOME/airsim-relay-data.tar.gz"; result=$?; docker compose start relay && exit "$result"; })
```

```sh
(cd /opt/airsim-relay-standalone/current && docker compose stop relay && \
  docker compose run --rm -T --no-deps --entrypoint tar relay -C /data -xzf - < "$HOME/airsim-relay-data.tar.gz" && docker compose start relay)
```

已有 systemd 版本的设备配对保存在原部署中。一行安装会创建自己的卷。原部署目录、手工反代及证书运维详见[原生部署指南](push-relay-worker/self-hosted/README.md)和[APNs 证书配置](push-relay-worker/self-hosted/APNS-CERTIFICATE-DEPLOYMENT.md)。

## 源码与测试

| 路径 | 用途 |
| --- | --- |
| `install.sh`、`compose.yaml`、`Dockerfile` | 获取源码、构建镜像、发布指定地址、管理版本 |
| `setup/web/` | 配置向导外层负责登录与导航，入口、推送及验收三个微前端按步骤独立加载 |
| `setup/server.mjs`、`setup/runtime.mjs` | 校验配置、装载证书、管理服务和持久化状态 |
| `push-relay-worker/src/` | 已有设备注册、心跳、命令去重和媒体协议 |
| `push-relay-worker/self-hosted/` | workerd 配置、SQLite 存储适配、基于证书的 APNs 发送器及测试 |

准备 Node.js 22 或更高版本、npm、OpenSSL 3 后，在仓库根目录运行以下命令。测试在临时目录生成自己的设备资料和证书。运行时集成测试使用空闲端口，宜在独立容器或测试机运行。

```sh
(cd push-relay-worker/self-hosted && npm ci && npm test)
node --test push-relay-worker/test/*.test.mjs
AIRSIM_TEST_WORKERD="$PWD/push-relay-worker/self-hosted/node_modules/.bin/workerd" node --test setup/test/*.test.mjs
```

## 来源与许可

本项目沿用 [AirSIM 上游](https://github.com/kai-wu-cortex/AirSIM) 的设备和媒体协议，以及本仓库已有的 APNs 证书验证、设备存储与 workerd 生成器，按 PolyForm Noncommercial License 1.0.0 分发。本仓库负责独立安装器和配置向导的维护。详见[项目许可](LICENSE)、[上游署名](NOTICE)及[第三方声明](THIRD_PARTY_NOTICES.md)。

运行时复用 [workerd](https://github.com/cloudflare/workerd)（Apache-2.0），npm 锁文件固定版本及完整性；测试依赖 [ws](https://github.com/websockets/ws)（MIT）。升级时应一起复测协议和持久化数据兼容性。网页使用浏览器原生 ES 模块和动态导入，所有资源由本机提供，无需另装前端框架或拉取 CDN 脚本。Apple 验签所用的公开根证书和中间证书来源、指纹见[证书清单](setup/trust/README.md)。
