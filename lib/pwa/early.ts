/**
 * Inline script for <head>. It runs before React hydrates, so the one-shot
 * beforeinstallprompt event isn't lost. It also registers the service worker.
 */
export const EARLY_PWA_SCRIPT = `
window.__bip=null;
addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bip=e;dispatchEvent(new Event('gl:bip'));});
addEventListener('appinstalled',function(){window.__installed=true;window.__bip=null;dispatchEvent(new Event('gl:bip'));});
if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});});}
`;
