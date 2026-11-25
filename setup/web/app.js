import { steps } from './modules.js';
import { initialDraft, relayError, appleError, payload } from './fields.js';

const screen = document.querySelector('#screen');
const notice = document.querySelector('#notice');
const nav = document.querySelector('#steps');
const logout = document.querySelector('#logout');
const service = document.querySelector('#service-state');
const sessionKey = 'airsim-setup-token';
let token = '', status = null, draft = null;
let step = 0, revision = 0, checked = false, applied = false, busy = false;

function message(text = '') {
  notice.textContent = text;
  notice.hidden = !text;
  if (text) notice.scrollIntoView({block: 'nearest'});
}

function saveToken(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(sessionKey, value);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* Private browsing can disable session storage. */ }
}

function updateShell() {
  for (const [i, button] of [...nav.children].entries()) {
    button.disabled = !status || busy;
    if (status && i === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  logout.hidden = !status;
  logout.disabled = busy;
  service.textContent = status?.running ? 'Relay 运行中' : status?.configured ? 'Relay 已停止' : status ? 'Relay 待配置' : '等待连接';
  service.parentElement.classList.toggle('running', Boolean(status?.running));
}

async function request(path, body) {
  let response;
  try {
    response = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: 'Bearer ' + token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), cache: 'no-store', redirect: 'error', credentials: 'omit',
    });
  } catch { throw new Error('连接控制台失败，请检查 SSH 隧道后重试。'); }
  if (!response.ok) {
    let problem;
    try { problem = (await response.json()).error; } catch { /* HTTP proxy errors may have no JSON. */ }
    if (response.status === 401) disconnect();
    throw new Error(problem || '请求失败，HTTP ' + response.status);
  }
  return path === 'ca' ? response.blob() : response.json();
}

async function task(operation) {
  if (busy) return;
  busy = true;
  updateShell();
  screen.inert = true;
  screen.setAttribute('aria-busy', 'true');
  message();
  try { await operation(); }
  catch (error) { message(error.message || '操作失败，请重试。'); }
  finally {
    busy = false;
    screen.inert = false;
    screen.removeAttribute('aria-busy');
    updateShell();
  }
}

function disconnect() {
  revision++;
  status = draft = null;
  step = 0;
  checked = applied = false;
  saveToken('');
  message();
  loginForm();
  updateShell();
}

function loginForm() {
  screen.innerHTML = `<div class="intro"><h1 tabindex="-1">连接控制台</h1>
    <p>输入安装命令生成的配置令牌，打开这台 Relay 的部署向导。</p></div>
    <form class="card auth"><div class="field"><label for="token">配置令牌</label>
    <input type="password" id="token" required autocomplete="off" autocapitalize="none" spellcheck="false"></div>
    <div class="actions"><button type="submit" class="primary next">连接</button></div></form>`;
  screen.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const input = screen.querySelector('#token');
    const value = input.value.trim();
    input.value = '';
    connect(value);
  };
}

async function connect(value) {
  await task(async () => {
    token = value;
    const result = await request('status');
    status = result.status;
    saveToken(value);
    draft = initialDraft(status);
    await render(0);
  });
}

function change(key, value) {
  draft[key] = value;
  checked = applied = false;
  message();
}

async function render(index) {
  const generation = ++revision;
  const module = await steps[index].load();
  if (generation !== revision || !status) return;
  step = index;
  updateShell();
  module.mount(screen, {
    draft, status, change, go, checked, applied, task, message, request,
    verify: () => task(async () => {
      await request('validate', await payload(draft, status));
      checked = true;
      await render(2);
    }),
    apply: () => task(async () => {
      if (!checked) throw new Error('请先验证当前配置。');
      const result = await request('apply', await payload(draft, status));
      status = result.status;
      draft = initialDraft(status);
      applied = true;
      checked = false;
      await render(2);
    }),
    refresh: () => task(async () => {
      status = (await request('status')).status;
      await render(2);
    }),
  });
  const heading = screen.querySelector('h1');
  heading?.focus({preventScroll: true});
}

async function go(index) {
  if (busy || !status) return;
  message();
  if (index > 0) {
    const error = relayError(draft, status);
    if (error) { await render(0); message(error); return; }
  }
  if (index > 1) {
    const error = appleError(draft, status);
    if (error) { await render(1); message(error); return; }
  }
  if (index < 2) applied = false;
  await render(index);
  screen.scrollIntoView({block: 'start'});
}

for (const [index, descriptor] of steps.entries()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'step';
  const number = document.createElement('span');
  number.className = 'step-number';
  number.setAttribute('aria-hidden', 'true');
  number.textContent = String(index + 1);
  button.append(number, document.createTextNode(descriptor.label));
  button.onclick = () => go(index).catch(err => message(err.message));
  nav.append(button);
}
logout.onclick = disconnect;
loginForm();
updateShell();

function readFragment() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has('token')) return false;
  const value = fragment.get('token').trim();
  history.replaceState(null, '', location.pathname + location.search);
  if (!busy && value) {
    disconnect();
    connect(value);
  }
  return true;
}

window.addEventListener('hashchange', readFragment);
if (!readFragment()) {
  try { token = sessionStorage.getItem(sessionKey) || ''; } catch { /* Optional storage. */ }
  if (token) connect(token);
}
