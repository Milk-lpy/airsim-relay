import { bindText, bindChoice, pemField, displayAddress } from '../fields.js';

export function mount(root, ctx) {
  root.innerHTML = `<div class="intro"><h1 tabindex="-1">Relay 入口</h1>
    <p>设置 iPhone 和安卓网关通过局域网或隧道访问的地址。</p></div>
    <form><section class="card"><h2>连接设置</h2><div class="fields">
    <div class="row"><div class="field"><label for="host">IP 地址或主机名</label>
    <input id="host" type="text" required maxlength="253" placeholder="例如 10.8.0.2" autocapitalize="none" autocomplete="off" spellcheck="false" aria-describedby="host-help">
    <p id="host-help" class="help">填写客户端能到达的地址，省略 https:// 和端口。</p></div>
    <div class="field"><label for="port">HTTPS 端口</label><input id="port" readonly></div></div>
    <details id="tls"><summary>HTTPS 证书设置</summary><div class="fields"><fieldset><legend>入口证书</legend><div class="radios">
    <label class="radio"><input name="tls-mode" type="radio" value="auto">由 Relay 签发</label>
    <label class="radio"><input name="tls-mode" type="radio" value="custom">使用已有证书</label></div></fieldset>
    <p class="help" id="tls-help"></p><div class="pem-pair"></div></div></details>
    <div class="preview"><div class="field-label">客户端连接地址</div><div class="preview-row"><code data-address></code>
    <button type="button" class="quiet" data-copy>复制地址</button></div></div></div></section>
    <div class="actions"><button type="submit" class="primary next">继续配置 Apple 推送</button></div></form>`;
  const host = bindText(root, '#host', ctx, 'host');
  host.addEventListener('input', () => displayAddress(root, ctx));
  root.querySelector('#port').value = ctx.draft.port;
  const inputs = root.querySelector('.pem-pair');
  pemField(inputs, 'serverCertificate', 'HTTPS 证书链', ctx);
  pemField(inputs, 'serverPrivateKey', 'HTTPS 私钥', ctx);
  bindChoice(root, 'tls-mode', ctx, 'customTls', value => value === 'custom');
  const tls = root.querySelector('#tls');
  tls.open = ctx.draft.customTls;
  function toggle() {
    inputs.hidden = !ctx.draft.customTls;
    root.querySelector('#tls-help').textContent = ctx.draft.customTls
      ? (ctx.status.hasCustomTls ? '留空沿用当前证书和私钥。更换时请同时提供两份文件。' : '证书需覆盖上方地址。请提供 PEM 证书链及对应的未加密私钥。')
      : 'Relay 为入口签发证书。启动后请在客户端安装并信任下载的根证书。';
  }
  tls.addEventListener('change', toggle);
  toggle();
  displayAddress(root, ctx);
  root.querySelector('form').onsubmit = event => { event.preventDefault(); ctx.go(1); };
}
