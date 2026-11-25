import { bindChoice, bindFile, bindText, pemField } from '../fields.js';

export function mount(root, ctx) {
  root.innerHTML = `<div class="intro"><h1 tabindex="-1">Apple 推送</h1>
    <p>配置 APNs 身份，让 Relay 为 iPhone 发送短信提醒和来电推送。</p></div>
    <form><section class="card"><h2>App 与推送环境</h2><div class="fields">
    <div class="field"><label for="bundle">iOS App Bundle ID</label>
    <input id="bundle" type="text" required maxlength="255" placeholder="com.example.airsim" autocapitalize="none" autocomplete="off" spellcheck="false"></div>
    <fieldset><legend>APNs 环境</legend><div class="radios">
    <label class="radio"><input name="environment" type="radio" value="sandbox">开发环境 · Sandbox</label>
    <label class="radio"><input name="environment" type="radio" value="production">生产环境 · Production</label></div>
    <p class="help choice-help">与 iPhone 自检中的 APNs 环境一致。development 对应 Sandbox。</p></fieldset></div></section>
    <section class="card"><h2>推送证书</h2><div class="fields">
    <p class="help" id="saved-primary" hidden>已保存 APNs 凭据。留空沿用，更换时请提供完整凭据。</p>
    <fieldset><legend>凭据格式</legend><div class="radios">
    <label class="radio"><input name="format" type="radio" value="p12">P12 文件</label>
    <label class="radio"><input name="format" type="radio" value="pem">PEM 证书和私钥</label></div></fieldset>
    <div id="p12" class="fields"><div class="field"><label for="p12-file">APNs Provider 证书（.p12）</label>
    <input type="file" id="p12-file" class="file" accept=".p12,.pfx,application/x-pkcs12"><span class="saved"></span></div>
    <div class="field"><label for="p12-password">P12 导出密码</label>
    <input type="password" id="p12-password" autocomplete="off" placeholder="文件无密码时留空"></div></div>
    <div class="pem-pair" id="primary-pair"></div>
    <details id="voip"><summary>VoIP 来电推送证书</summary><div class="fields">
    <fieldset><legend>PushKit 凭据</legend><div class="radios">
    <label class="radio"><input name="voip-mode" type="radio" value="main">使用主证书</label>
    <label class="radio"><input name="voip-mode" type="radio" value="separate">使用单独的 VoIP 证书</label></div></fieldset>
    <p id="voip-help" class="help"></p><div id="voip-pair" class="pem-pair"></div></div></details>
    </div></section><div class="actions"><button type="button" class="secondary" id="back">上一步</button>
    <button type="submit" class="primary next">核对配置</button></div></form>`;
  bindText(root, '#bundle', ctx, 'bundleId');
  bindChoice(root, 'environment', ctx, 'environment');
  bindChoice(root, 'format', ctx, 'format');
  bindChoice(root, 'voip-mode', ctx, 'separateVoip', value => value === 'separate');
  const password = bindText(root, '#p12-password', ctx, 'pkcs12Password');
  const p12 = root.querySelector('#p12');
  bindFile(p12, root.querySelector('#p12-file'), 'pkcs12', ctx, () => {
    password.value = '';
    ctx.change('pkcs12Password', '');
  });
  const primary = root.querySelector('#primary-pair'), voip = root.querySelector('#voip-pair');
  pemField(primary, 'certificate', 'APNs 证书', ctx);
  pemField(primary, 'privateKey', 'APNs 私钥', ctx);
  pemField(voip, 'voipCertificate', 'VoIP 证书', ctx);
  pemField(voip, 'voipPrivateKey', 'VoIP 私钥', ctx);
  root.querySelector('#voip').open = ctx.draft.separateVoip;
  root.querySelector('#saved-primary').hidden = !ctx.status.configured;
  function toggle() {
    primary.hidden = ctx.draft.format !== 'pem';
    p12.hidden = !primary.hidden;
    voip.hidden = !ctx.draft.separateVoip;
    root.querySelector('#voip-help').textContent = ctx.draft.separateVoip
      ? (ctx.status.hasVoipCertificate ? '留空沿用已保存的 VoIP 证书和私钥。' : '提供专用 VoIP 推送证书和对应的未加密 PEM 私钥。')
      : '主证书需要授权该 App 的 .voip Topic。';
  }
  root.querySelector('form').addEventListener('change', toggle);
  toggle();
  root.querySelector('#back').onclick = () => ctx.go(0);
  root.querySelector('form').onsubmit = event => { event.preventDefault(); ctx.go(2); };
}
