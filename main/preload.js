/**
 * Мост между окном и главным процессом.
 * В интерфейсе доступно как window.api
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // состояние и настройки
  getState: () => ipcRenderer.invoke('state:get'),
  setTheme: (theme) => ipcRenderer.invoke('settings:setTheme', theme),
  setInterval: (sec) => ipcRenderer.invoke('settings:setInterval', sec),
  logout: () => ipcRenderer.invoke('settings:logout'),

  // авторизация
  loginViaWindow: () => ipcRenderer.invoke('auth:loginWindow'),
  cancelAuth: () => ipcRenderer.invoke('auth:cancel'),

  // мониторинг
  startMonitor: () => ipcRenderer.invoke('monitor:start'),
  stopMonitor: () => ipcRenderer.invoke('monitor:stop'),

  // автовыдача
  listPets: () => ipcRenderer.invoke('pets:list'),
  savePet: (data) => ipcRenderer.invoke('pets:save', data),
  removePet: (id) => ipcRenderer.invoke('pets:remove', id),
  pastePetImage: () => ipcRenderer.invoke('pets:paste'),
  pickPetImage: () => ipcRenderer.invoke('pets:pickFile'),
  deliveryState: () => ipcRenderer.invoke('delivery:state'),
  deliverySettings: (patch) => ipcRenderer.invoke('delivery:settings', patch),
  deliver: (orderId) => ipcRenderer.invoke('delivery:deliver', orderId),
  markDelivered: (id) => ipcRenderer.invoke('delivery:markDone', id),
  testDelivery: (buyer, petId) => ipcRenderer.invoke('delivery:test', buyer, petId),
  stopDelivery: () => ipcRenderer.invoke('delivery:stop'),
  checkHelper: () => ipcRenderer.invoke('delivery:check'),

  // окно
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // события от главного процесса
  on: (channel, callback) => {
    const allowed = ['monitor:profile', 'monitor:orders', 'monitor:newOrder', 'monitor:error', 'monitor:status', 'app:info', 'delivery:update', 'delivery:log'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => callback(data));
    }
  },
});
