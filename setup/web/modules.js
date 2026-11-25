export const steps = [
  { label: 'Relay 入口', load: () => import('./modules/relay.js') },
  { label: 'Apple 推送', load: () => import('./modules/apple.js') },
  { label: '验证与启动', load: () => import('./modules/review.js') },
];
