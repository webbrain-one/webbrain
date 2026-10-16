import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve('.');
const locales = ['en', 'es', 'fr', 'tr', 'zh', 'ru', 'uk', 'ar', 'ja', 'ko', 'id', 'th', 'ms', 'tl', 'pl', 'he', 'hi', 'pt', 'vi', 'bn', 'fa', 'nl', 'de'];
const output = resolve(process.env.QUOTA_UI_OUTPUT || resolve(tmpdir(), 'webbrain-compass-review'));
await mkdir(output, { recursive: true });
const fixture = (build, locale) => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/${build}/styles/sidepanel.css">
<style>:root{--accent:#6c5dd3;--accent-dim:#f0edfb;--accent-hover:#5546b8;--text-primary:#242235;--border:#dedbe8;--bg-secondary:#fff}body{margin:0;padding:12px;box-sizing:border-box;background:#faf9ff;color:#242235;font:14px system-ui;overflow:auto}main{width:100%;box-sizing:border-box}.message{margin:0;width:100%}.message-text{padding:12px;box-sizing:border-box;border:1px solid #dedbe8;border-radius:10px}</style>
<main id="history"><div class="message assistant" data-run-mode="act"><div id="card" class="message-text"></div></div></main>
<script type="module">
import { createQuotaController } from '/src/${build}/src/ui/compass-quota.js';
import { quotaTranslations } from '/src/${build}/src/ui/locales/compass-quota-copy.mjs';
import en from '/src/${build}/src/ui/locales/en.js';
import dict from '/src/${build}/src/ui/locales/${locale}.js';
const code=${JSON.stringify(locale)};
document.documentElement.lang=code; document.documentElement.dir=['ar','he','fa'].includes(code)?'rtl':'ltr';
const t=(key,params={})=>(quotaTranslations[code][key] || dict[key] || en[key] || key).replace(/[{]([a-z]+)[}]/g,(_,k)=>params[k] ?? '{'+k+'}');
window.requests=[];window.opened=[];window.switched=[];window.continuations=[];window.settingsOpened=0;window.deferredRefresh=[];
window.claim={eligible:true,status:'draft',claim_id:null,share_url:null,remaining_credit_usd:0};
window.usage={tier:'free',base_weekly_allowance_usd:0.375,weekly_limit_usd:0.375,promotional_balance_usd:0,next_reset_at:'2026-10-12T00:00:00Z'};
window.makeController=()=>createQuotaController({t,locale:()=>code,request:async(path,body)=>{
 requests.push({path,body});if(window.offline)throw Error('offline');
 if(path==='/promotions/events')return {};
 if(path==='/promotions/social/claims'){
  if(window.delaySubmission)await new Promise(resolve=>{window.releaseSubmission=resolve;});
  if(window.rejectSubmission)throw Error('Submission not received.');
  claim={...claim,status:window.legacySubmission?'pending':'approved',eligible:!!window.legacySubmission,remaining_credit_usd:window.legacySubmission?0:0.5,platform:body.platform,post_url:body.post_url};return {...claim};
 }
 if(path==='/promotions/social')claim={...claim,claim_id:'opaque-random-claim',share_url:'https://webbrain.one/?share=opaque-random-claim'};
 const snapshot=path==='/usage'?{...usage,social_claim:{...claim}}:{...claim};
 if(window.delayRefresh)return new Promise((resolve,reject)=>deferredRefresh.push(()=>window.failDelayedRefresh?reject(Error('offline')):resolve(snapshot)));
 return snapshot;
},openUrl:url=>opened.push(url),providers:async()=>[{id:'webbrain_cloud',label:'WebBrain Compass'},{id:'own-key',label:'My API key'},{id:'local',label:'Local model'}],switchProvider:async id=>{if(window.providerError)throw Error(window.providerError);switched.push(id);},openSettings:()=>settingsOpened++,continueTask:(_button,context)=>continuations.push(context),persist:()=>{}});
window.controller=makeController();controller.mount(document.querySelector('#card'),{code:'webbrain_cloud_free_tier_exceeded',usage:{...usage,social_claim:claim},subscribe_url:'https://buy.stripe.com/test?client_reference_id=device-guid'},{mode:'act',foreground:true});
window.ready=true;
</script>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/quota') {
      const build = url.searchParams.get('build');
      if (!['chrome', 'firefox'].includes(build)) throw Error('unknown build');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const requestedLocale = url.searchParams.get('locale');
      const locale = locales.find(code => code === requestedLocale) || 'en';
      res.end(fixture(build, locale)); return;
    }
    const path = resolve(root, '.' + url.pathname);
    if (!path.startsWith(root + sep)) throw Error('outside root');
    res.setHeader('Content-Type', ['.js', '.mjs'].includes(extname(path)) ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/plain');
    res.end(await readFile(path));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let checks = 0;
try {
  const injectedLocale = '</script><script>window.localeInjection=true</script>';
  for (const build of ['chrome', 'firefox']) {
    const html = await (await fetch(`${origin}/quota?build=${build}&locale=${encodeURIComponent(injectedLocale)}`)).text();
    assert.doesNotMatch(html, /localeInjection/);
    assert.match(html, /const code="en"/); checks += 2;
  }
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    if (process.env.QUOTA_UI_BROWSER && process.env.QUOTA_UI_BROWSER !== build) continue;
    const browser = await engine.launch();
    try {
      for (const lang of locales) {
        const page = await browser.newPage({ viewport: { width: 280, height: 1000 }, timezoneId: 'Europe/Istanbul' });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(`${origin}/quota?build=${build}&locale=${lang}`);
        await page.waitForFunction(() => window.ready);
        assert.equal(await page.locator('.quota-choices button:visible').count(), 2); checks++;
        assert.equal(await page.locator('.quota-other').count(), 0); checks++;
        assert.equal(await page.locator('#card').evaluate(el => /quota\.|\{(?:base|credit|time)\}/.test(el.textContent)), false); checks++;
        assert.equal(await page.evaluate(() => continuations.length), 0); checks++;
        if (lang === 'en') {
          assert.equal(await page.evaluate(() => requests.filter(r => r.path === '/promotions/social').length), 0); checks++;
          assert.match(await page.locator('.quota-balance').textContent(), /\$0\.375/);
          assert.match(await page.locator('.quota-reset').textContent(), /3:00:00 AM/);
          await page.locator('.quota-share').focus();
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.className), 'subscribe-btn');
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.className), 'quota-refresh'); checks += 3;
          await page.locator('.subscribe-btn').click();
          assert.equal(await page.evaluate(() => opened.at(-1)), 'https://buy.stripe.com/test?client_reference_id=device-guid');
          assert.equal(await page.evaluate(() => continuations.length), 0); checks += 2;
        }
        await page.locator('.quota-share').focus();
        await page.keyboard.press('Enter');
        await page.locator('.quota-claim textarea').waitFor();
        assert.equal(await page.locator('.quota-claim textarea').evaluate(el => el === document.activeElement), true); checks++;
        assert.equal(await page.evaluate(() => requests.filter(r => r.path.endsWith('/claims')).length), 0); checks++;
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${build}/${lang}: narrow claim overflow`); checks++;
        if (['en', 'tr', 'ar', 'de'].includes(lang)) await page.screenshot({ path: resolve(output, `${build}-${lang}-claim-280.png`), fullPage: true });
        if (lang === 'en') {
          const copy = 'WebBrain needs improvement. https://webbrain.one/?share=opaque-random-claim';
          await page.locator('.quota-claim textarea').fill('');
          await page.evaluate(() => controller.refreshAll());
          assert.equal(await page.locator('.quota-claim textarea').inputValue(), '');
          assert.equal(await page.locator('.quota-claim textarea').evaluate(el => el === document.activeElement), true); checks += 2;
          await page.locator('.quota-claim textarea').fill(copy);
          for (const name of ['X', 'LinkedIn', 'Bluesky']) await page.locator('.quota-composers').getByRole('button', { name, exact: true }).click();
          assert.equal(new URL(await page.evaluate(() => opened.at(-3))).searchParams.get('text'), copy);
          assert.equal(new URL(await page.evaluate(() => opened.at(-1))).searchParams.get('text'), copy); checks += 2;
          await page.locator('.quota-claim select').selectOption('bluesky');
          await page.locator('.quota-claim input').fill('https://bsky.app/profile/a.bsky.social/post/3abc');
          await page.evaluate(() => { const html = document.querySelector('#history').innerHTML; document.querySelector('#history').innerHTML = html; controller = makeController(); controller.restore(document.querySelector('#history')); });
          assert.equal(await page.locator('.quota-claim textarea').inputValue(), copy);
          assert.equal(await page.locator('.quota-claim select').inputValue(), 'bluesky');
          assert.match(await page.locator('.quota-claim input').inputValue(), /bsky\.app/); checks += 3;
          // Older servers may still return pending. Keep stale-response/remount compatibility.
          await page.evaluate(() => { window.legacySubmission = true; });
          // A focus refresh may already have read draft state when submission completes.
          await page.evaluate(() => { window.delayRefresh = true; window.staleRefresh = controller.refreshAll(); });
          assert.equal(await page.evaluate(() => deferredRefresh.length), 1); checks++;
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => claim.status === 'pending');
          await page.evaluate(async () => { window.delayRefresh = false; deferredRefresh.splice(0).forEach(resolve => resolve()); await staleRefresh; });
          assert.equal(await page.locator('#card').evaluate(el => JSON.parse(el.dataset.quota).usage.social_claim.status), 'pending'); checks++;
          assert.match(await page.locator('.quota-status').textContent(), /Refresh status to receive your credit automatically/);
          assert.equal(await page.locator('.quota-claim textarea').count(), 0); checks += 2;
          await page.evaluate(() => { claim.status = 'rejected'; claim.reason = 'Add the generated link.'; });
          await page.locator('.quota-refresh').click();
          await page.locator('.quota-claim textarea').waitFor();
          assert.match(await page.locator('.quota-status').textContent(), /Add the generated link/); checks++;
          await page.locator('.quota-claim input').fill('https://bsky.app/profile/a.bsky.social/post/corrected');
          await page.evaluate(() => { window.delayRefresh = true; window.staleRefresh = controller.refreshAll(); });
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => claim.status === 'pending');
          await page.evaluate(async () => { window.failDelayedRefresh = true; window.delayRefresh = false; deferredRefresh.splice(0).forEach(resolve => resolve()); await staleRefresh; window.failDelayedRefresh = false; });
          assert.match(await page.locator('.quota-status').textContent(), /Refresh status to receive your credit automatically/); checks++;
          // Remounting during an outstanding POST must neither allow a second submission
          // nor retain the pre-submission status after the response arrives.
          await page.evaluate(async () => { claim.status = 'rejected'; await controller.refreshAll(); window.delaySubmission = true; });
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => typeof releaseSubmission === 'function');
          await page.evaluate(() => controller.restore(document.querySelector('#history'), true));
          assert.equal(await page.locator('.quota-claim form button[type=submit]').isDisabled(), true); checks++;
          await page.evaluate(() => { window.delaySubmission = false; releaseSubmission(); });
          await page.waitForFunction(() => !document.querySelector('.quota-claim form'));
          assert.match(await page.locator('.quota-status').textContent(), /Refresh status to receive your credit automatically/);
          assert.equal(await page.evaluate(() => continuations.length), 0); checks += 2;
          await page.evaluate(async () => { claim.status = 'rejected'; await controller.refreshAll(); window.delaySubmission = true; window.rejectSubmission = true; window.releaseSubmission = null; });
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => typeof releaseSubmission === 'function');
          await page.evaluate(() => controller.restore(document.querySelector('#history'), true));
          assert.equal(await page.locator('.quota-claim form button[type=submit]').isDisabled(), true); checks++;
          await page.evaluate(() => { window.delaySubmission = false; releaseSubmission(); });
          await page.waitForFunction(() => document.querySelector('.quota-claim form button[type=submit]')?.disabled === false);
          assert.equal(await page.locator('.quota-claim form button[type=submit]').isDisabled(), false);
          assert.equal(await page.evaluate(() => continuations.length), 0); checks += 2;
          await page.evaluate(() => { window.rejectSubmission = false; window.legacySubmission = false; });
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => !document.querySelector('.quota-claim form'));
          assert.match(await page.locator('.quota-status').textContent(), /Approved/); checks++;
          assert.equal(await page.locator('.quota-share:visible').count(), 0);
          assert.match(await page.locator('.quota-balance').textContent(), /\$0\.50/);
          assert.equal(await page.evaluate(() => continuations.length), 0); checks += 3;
          assert.equal(await page.locator('.quota-providers').count(), 0); checks++;
          await page.evaluate(() => { const html = document.querySelector('#history').innerHTML; document.querySelector('#history').innerHTML = html; controller = makeController(); controller.restore(document.querySelector('#history')); });
          assert.equal(await page.locator('.quota-share:visible').count(), 0); checks++;
          await page.locator('.subscribe-resume-btn').click();
          assert.equal(await page.evaluate(() => continuations.length), 1);
          assert.equal(await page.evaluate(() => requests.filter(r => r.body?.event === 'continuation_after_reward').length), 1); checks += 2;
          await page.evaluate(() => { claim.remaining_credit_usd = 0; claim.status = 'redeemed'; });
          await page.locator('.quota-refresh').click();
          assert.equal(await page.locator('.quota-share:visible').count(), 0);
          await page.evaluate(() => { usage.tier = 'paid'; });
          await page.locator('.quota-refresh').click();
          assert.equal(await page.evaluate(() => continuations.length), 1); checks += 2;
          await page.setViewportSize({ width: 420, height: 850 });
          await page.screenshot({ path: resolve(output, `${build}-quota-awarded-420.png`), fullPage: true });
        }
        if (lang !== 'en') {
          await page.locator('.quota-claim input').fill('https://x.com/name/status/123');
          await page.locator('.quota-claim form button[type=submit]').click();
          await page.waitForFunction(() => document.querySelector('.quota-share')?.hidden);
          assert.equal(await page.locator('#card').evaluate(el => JSON.parse(el.dataset.quota).usage.social_claim.remaining_credit_usd), 0.5); checks++;
          assert.equal(await page.evaluate(() => continuations.length), 0); checks++;
        }
        assert.deepEqual(errors, []); checks++;
        await page.close();
      }
      console.log(`${build}: quota UI, keyboard navigation, 23 locales, restored claim form and explicit continuation passed`);
    } finally { await browser.close(); }
  }
  console.log(`${checks} rendered UI assertions passed. Screenshots: ${output}`);
} finally { await new Promise(r => server.close(r)); }
