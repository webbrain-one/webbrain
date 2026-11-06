'use strict';

// Runs in every page's main frame before the page's own scripts, and gives
// navigator.userAgentData the same brands as the Sec-CH-UA headers that
// app/identity.js adds: Murshid next to Chromium, or Google Chrome when
// Settings says so. Electron's own list names only Chromium.

const { contextBridge, ipcRenderer } = require('electron');

let id = null;
try { id = ipcRenderer.sendSync('murshid-identity'); } catch {}
if (id && typeof navigator !== 'undefined' && navigator.userAgentData) {
  try {
    contextBridge.executeInMainWorld({ func: patchUserAgentData, args: [id] });
  } catch (error) {
    console.error('[murshid] could not set navigator.userAgentData:', error);
  }
}

// Runs in the page's world. The native functions are wrapped in Proxies, so
// they keep their names, still check what they are called on, and still print
// as native code.
function patchUserAgentData(id) {
  const proto = Object.getPrototypeOf(navigator.userAgentData);
  const copy = (list) => list.map((b) => ({ brand: b.brand, version: b.version }));
  const brands = Object.freeze(copy(id.brands));

  const brandsDesc = Object.getOwnPropertyDescriptor(proto, 'brands');
  Object.defineProperty(proto, 'brands', {
    ...brandsDesc,
    get: new Proxy(brandsDesc.get, {
      apply(target, self, args) {
        Reflect.apply(target, self, args);
        return brands;
      },
    }),
  });

  proto.getHighEntropyValues = new Proxy(proto.getHighEntropyValues, {
    apply(target, self, args) {
      return Reflect.apply(target, self, args).then((values) => {
        if ('brands' in values) values.brands = copy(id.brands);
        if ('fullVersionList' in values) values.fullVersionList = copy(id.fullVersionList);
        if ('uaFullVersion' in values) values.uaFullVersion = id.uaFullVersion;
        return values;
      });
    },
  });

  proto.toJSON = new Proxy(proto.toJSON, {
    apply(target, self, args) {
      return { ...Reflect.apply(target, self, args), brands: copy(id.brands) };
    },
  });
}
