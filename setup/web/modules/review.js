import { address, displayAddress } from '../fields.js';

async function downloadCA(ctx) {
  const blob = await ctx.request('ca');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'AirSIM-Relay-CA.crt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function mount(root, ctx) {
  const {draft, status} = ctx;
  if (ctx.applied) {
    root.innerHTML = `<div class="intro"><h1 tabindex="-1">部署结果</h1>
      <p>将连接地址填入安卓和 iPhone 的 AirSIM 设置。</p></div><section class="card success">
      <div class="status-row"><h2 id="result"></h2><button type="button" class="quiet" id="refresh">刷新状态</button></div>
      <p id="problem" class="help" role="status"></p><div class="preview"><div class="field-label">客户端连接地址</div>
      <div class="preview-row"><code data-address></code><button type="button" class="quiet" data-copy></button></div></div>
      <div id="ca"><h3>客户端根证书</h3><p class="help">下载后安装到连接这台 Relay 的设备。iPhone 还需在「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任。</p>
      <button type="button" class="secondary" id="download">下载根证书</button></div></section>
      <div class="actions"><button type="button" class="secondary" id="edit">编辑配置</button></div>`;
    root.querySelector('#result').textContent = status.running ? 'Relay 已启动' : '配置已保存，Relay 已停止';
    root.querySelector('#problem').textContent = status.lastError || '';
    root.querySelector('#ca').hidden = status.hasCustomTls;
    root.querySelector('#download').onclick = () => ctx.task(() => downloadCA(ctx));
    root.querySelector('#refresh').onclick = ctx.refresh;
    root.querySelector('#edit').onclick = () => ctx.go(0);
    displayAddress(root, ctx);
    return;
  }
  root.innerHTML = `<div class="intro"><h1 tabindex="-1">验证与启动</h1>
    <p>核对设备连接地址和推送身份，验证通过后应用配置。</p></div><section class="card">
    <h2>配置摘要</h2><dl class="summary"></dl><div class="validation" role="status" id="validation"></div>
    <div class="actions"><button type="button" class="secondary" id="back">上一步</button>
    <button type="button" class="primary" id="action"></button></div></section>
    <section class="card" id="current" hidden><div class="status-row"><h2>当前服务</h2>
    <button type="button" class="quiet" id="refresh">刷新状态</button></div><p class="help" id="current-state"></p>
    <button type="button" class="secondary" id="download">下载现用根证书</button></section>`;
  const primaryChanged = draft.format === 'p12' ? draft.pkcs12 : draft.certificate;
  const rows = [
    ['客户端地址', address(draft)],
    ['HTTPS 证书', draft.customTls ? '自定义证书' : 'Relay 签发'],
    ['Bundle ID', draft.bundleId.trim()],
    ['APNs 环境', draft.environment === 'production' ? '生产环境 · Production' : '开发环境 · Sandbox'],
    ['APNs 证书', primaryChanged ? (draft.format === 'p12' ? '导入 P12' : '导入 PEM') : '沿用已保存凭据'],
    ['VoIP 证书', draft.separateVoip ? '单独的 VoIP 证书' : '使用主证书'],
  ];
  const summary = root.querySelector('dl');
  for (const [label, value] of rows) {
    const group = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    group.append(term, detail);
    summary.append(group);
  }
  const action = root.querySelector('#action');
  root.querySelector('#validation').textContent = ctx.checked
    ? '配置验证通过。双端连通性和真实推送需在设备上测试。'
    : '待验证 · 检查入口证书、APNs 私钥和推送主题。';
  action.textContent = ctx.checked ? (status.configured ? '应用配置并重启' : '应用配置并启动') : '验证配置';
  action.onclick = () => {
    action.textContent = ctx.checked ? '正在启动…' : '正在验证…';
    const original = ctx.checked ? (status.configured ? '应用配置并重启' : '应用配置并启动') : '验证配置';
    (ctx.checked ? ctx.apply() : ctx.verify()).finally(() => { action.textContent = original; });
  };
  root.querySelector('#back').onclick = () => ctx.go(1);
  root.querySelector('#current').hidden = !status.configured;
  root.querySelector('#current-state').textContent = (status.running ? 'Relay 运行中' : 'Relay 已停止') + (status.lastError ? ' · ' + status.lastError : '');
  root.querySelector('#download').hidden = status.hasCustomTls;
  root.querySelector('#download').onclick = () => ctx.task(() => downloadCA(ctx));
  root.querySelector('#refresh').onclick = ctx.refresh;
}
