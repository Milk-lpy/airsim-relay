# APNs 客户端证书配置

APNs 代理为普通推送使用 App Bundle ID，为 PushKit 推送使用该 Bundle ID 加 `.voip`。两类推送都要求证书授权相应 Topic。证书代理通过 HTTP/2、TLS 1.2 或更高版本连接 Apple，在握手中出示客户端证书并验证 Apple 服务端证书。

## 准备证书与私钥

在私有目录创建 RSA 2048 位私钥和 CSR。下面的命令会写入新文件，续期时应使用新的空目录。只将 CSR 提交给拥有相应 App ID 权限的 Apple 开发者团队。

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out apns.key
openssl req -new -key apns.key -out apns.csr -subj '/CN=AirSIM APNs Provider'
openssl req -in apns.csr -verify -noout
```

从 Apple 取得签发的 Provider 证书。如果下载的是 DER 编码的 `.cer`，可以转换为 PEM。核对后两条命令输出的公钥指纹应相同。

```sh
openssl x509 -inform DER -in provider.cer -out apns.pem
openssl pkey -in apns.key -pubout -outform DER | openssl dgst -sha256
openssl x509 -in apns.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
```

按实际签发链从 [Apple PKI](https://www.apple.com/certificateauthority/) 取得根证书与中间证书，核对官方指纹后转换为 PEM。在每一份客户端证书所在的目录准备 `apple-roots.pem` 与 `apple-intermediates.pem`，代理依赖这两个文件校验证书链。若普通推送证书无法授权 VoIP Topic，需提供一份 Apple 签发且授权对应 VoIP Topic 的服务证书及其私钥。

## 填写服务配置

在 Git 仓库之外保管证书和密钥。证书目录可设为 `0700`、私钥设为 `0600`，所有者为 `airsim-relay` 服务账户，确保该账户能读取证书链。将下列 JSON 字段合并到私有服务配置。把 `com.example.airsim` 替换为 App 实际签名使用的 Bundle ID。

```json
{
  "APNS_AUTH_MODE": "certificate",
  "APNS_ENVIRONMENT": "production",
  "APNS_BUNDLE_ID": "com.example.airsim",
  "ALLOWED_BUNDLE_ID": "com.example.airsim",
  "APNS_CERT_PATH": "/etc/airsim/apns/apns.pem",
  "APNS_KEY_PATH": "/etc/airsim/apns/apns.key"
}
```

另用 VoIP 证书时，增加 `APNS_VOIP_CERT_PATH` 与 `APNS_VOIP_KEY_PATH` 两个字段。测试环境使用 `sandbox` 和该环境注册的 Token；生产环境使用 `production`。代理在启动时检查客户端认证用途、有效期、证书链、私钥、公钥、环境与 Topic 扩展（含 OID `1.2.840.113635.100.6.3.4` 和 `1.2.840.113635.100.6.3.6`）。Web 入口的 HTTPS 证书由入口代理单独管理。

## 验证与到期通知

安装完成后运行以下命令。第一条从服务账户读取配置并输出授权 Topic 与到期状态；配置项有误时可查看该服务的 journal。监控在有效期剩余 30 天或更短时触发告警单元，默认写入系统日志，可接入自己的告警渠道。

```sh
sudo systemctl start airsim-apns-monitor.service
sudo journalctl -u airsim-apns-monitor.service -n 10 --no-pager
sudo systemctl enable --now airsim-apns-monitor.timer
curl --fail --silent --show-error http://127.0.0.1:8790/healthz
```

更换证书时保留原有效文件以备回退，更新私有配置指向的新证书后运行一次监控验证，再重启 `airsim-apns.service` 并复核健康接口。在授权的测试设备分别触发普通通知与 VoIP 来电，核对服务端 APNs 状态及终端实际接收结果。留意日志中的证书路径、Bundle ID 等部署信息，发布诊断前进行脱敏。
