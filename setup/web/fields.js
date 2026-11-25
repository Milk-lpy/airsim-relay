export function initialDraft(status) {
  return {
    host: status.host || '', port: status.port || 18788, bundleId: status.bundleId || '',
    environment: status.environment || 'sandbox', format: 'p12',
    customTls: Boolean(status.hasCustomTls), separateVoip: Boolean(status.hasVoipCertificate),
    certificate: '', privateKey: '', voipCertificate: '', voipPrivateKey: '',
    serverCertificate: '', serverPrivateKey: '', pkcs12: null, pkcs12Password: '',
  };
}

export function address(draft) {
  const host = draft.host.trim();
  if (!host) return '';
  return 'https://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + draft.port;
}

export function bindText(root, selector, context, key) {
  const input = root.querySelector(selector);
  input.value = context.draft[key];
  input.addEventListener('input', () => context.change(key, input.value));
  return input;
}

export function bindChoice(root, name, context, key, decode = value => value) {
  const inputs = root.querySelectorAll('input[name="' + name + '"]');
  for (const input of inputs) {
    input.checked = context.draft[key] === decode(input.value);
    input.addEventListener('change', () => {
      if (input.checked) context.change(key, decode(input.value));
    });
  }
}

export function bindFile(root, input, key, context, onClear) {
  const name = root.querySelector('.saved');
  function display() {
    const file = context.draft[key];
    name.textContent = '';
    if (!(file instanceof File)) return;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = '移除文件';
    remove.onclick = () => {
      input.value = '';
      context.change(key, '');
      onClear?.();
      display();
    };
    name.append('已选文件 · ' + file.name + ' ', remove);
  }
  input.addEventListener('change', () => {
    if (input.files.length === 0) return;
    context.change(key, input.files[0]);
    display();
  });
  display();
}

export function pemField(container, key, label, context) {
  const field = document.createElement('div');
  field.className = 'field pem-field';
  // Only module-owned constants are interpolated here. Uploaded filenames and values use DOM properties.
  field.innerHTML = `<label for="${key}-file">${label}</label>
    <input type="file" class="file" id="${key}-file" accept=".pem,.crt,.key,text/plain">
    <span class="saved"></span>
    <details><summary>粘贴 PEM 文本</summary><textarea autocomplete="off" autocapitalize="none" spellcheck="false"
      aria-label="${label} PEM 文本" placeholder="-----BEGIN …-----"></textarea></details>`;
  const input = field.querySelector('input'), area = field.querySelector('textarea');
  const value = context.draft[key];
  if (typeof value === 'string' && value) {
    area.value = value;
    field.querySelector('details').open = true;
  }
  bindFile(field, input, key, context);
  input.addEventListener('change', () => {
    if (input.files.length) area.value = '';
  });
  area.addEventListener('input', () => {
    input.value = '';
    field.querySelector('.saved').textContent = '';
    context.change(key, area.value);
  });
  container.append(field);
}

export function relayError(draft, status) {
  if (!draft.host.trim()) return '请填写客户端可以访问的 IP 地址或主机名。';
  if (/[\s/?#@\[\]]/.test(draft.host.trim())) return '地址仅填写 IP 或主机名，省略协议、方括号和路径。';
  if (draft.customTls) return pairError(draft.serverCertificate, draft.serverPrivateKey, status.hasCustomTls, 'HTTPS');
  return '';
}

function hasValue(value) {
  return value instanceof File || Boolean(value?.trim());
}

function pairError(certificate, key, stored, label) {
  if ((!stored || hasValue(certificate) || hasValue(key)) && !(hasValue(certificate) && hasValue(key))) {
    return '请同时提供' + label + '证书及对应的私钥。';
  }
  return '';
}

export function appleError(draft, status) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(draft.bundleId.trim())) {
    return '请填写完整的 iOS App Bundle ID。';
  }
  if (draft.format === 'p12' && !draft.pkcs12 && (!status.configured || draft.pkcs12Password)) {
    return '请选择包含 APNs 推送证书和私钥的 P12 文件。';
  }
  if (draft.format === 'pem') {
    const error = pairError(draft.certificate, draft.privateKey, status.configured, 'APNs ');
    if (error) return error;
  }
  if (draft.separateVoip) return pairError(draft.voipCertificate, draft.voipPrivateKey, status.hasVoipCertificate, 'VoIP ');
  return '';
}

async function fileValue(value, binary = false) {
  if (!(value instanceof File)) return value || '';
  if (value.size > 1024 * 1024) throw new Error('配置文件超过服务端的 1 MiB 请求上限。');
  if (!value.size) throw new Error('所选文件为空。');
  if (!binary) return value.text();
  const bytes = new Uint8Array(await value.arrayBuffer());
  try {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(text);
  } finally { bytes.fill(0); }
}

export async function payload(draft, status) {
  const error = relayError(draft, status) || appleError(draft, status);
  if (error) throw new Error(error);
  const body = {host: draft.host.trim(), port: draft.port, bundleId: draft.bundleId.trim(), environment: draft.environment};
  if (draft.format === 'p12' && draft.pkcs12) {
    body.pkcs12 = await fileValue(draft.pkcs12, true);
    body.pkcs12Password = draft.pkcs12Password;
  }
  const pairs = [
    [draft.format === 'pem', false, 'certificate', 'privateKey'],
    [draft.separateVoip, status.hasVoipCertificate, 'voipCertificate', 'voipPrivateKey'],
    [draft.customTls, status.hasCustomTls, 'serverCertificate', 'serverPrivateKey'],
  ];
  for (const [enabled, stored, cert, key] of pairs) {
    if (enabled && hasValue(draft[cert])) {
      body[cert] = await fileValue(draft[cert]);
      body[key] = await fileValue(draft[key]);
    } else if (!enabled && stored) {
      body[cert] = null;
      body[key] = null;
    }
  }
  return body;
}

export function displayAddress(root, context) {
  const value = address(context.draft);
  const preview = root.querySelector('[data-address]');
  preview.textContent = value || '填写地址后生成';
  const copy = root.querySelector('[data-copy]');
  copy.disabled = !value;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = '已复制';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(preview);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copy.textContent = '请复制选中地址';
    }
  };
  copy.textContent = '复制地址';
}
