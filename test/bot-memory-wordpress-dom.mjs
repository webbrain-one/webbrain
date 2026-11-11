import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, firefox } from 'playwright';
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
 for(const [build,engine] of [['chrome',chromium],['firefox',firefox]]) {
  browser=await engine.launch();const page=await browser.newPage();
  const {observeMemoryPageInPage,observeBotMemoryPage}=await import(`../src/${build}/src/agent/bot-memory.js`);
  const api={scripting:{executeScript:async ({args})=>[{frameId:0,result:await page.evaluate(observeMemoryPageInPage,args[0])}]}};
  await page.goto(origin+'/wp-admin/post-new.php');
  await page.setContent(`<form id="post" method="post" action="post.php"><input type="hidden" name="post_ID" value="2630"><input type="hidden" name="_wpnonce" value="private-nonce"><input id="title" value="New article"><textarea id="content">Article body</textarea><span id="sample-permalink"><a href="${origin}/new-article/">Article permalink</a></span><input id="publish" type="submit" value="Yayınla"></form>`);
  const editor=await observeBotMemoryPage(1,{selector:'#publish',toolName:'click_ax'},api);
  assert.equal(editor.elementFacts.label,'Yayınla');
  const record=editor.targets.find(t=>t.kind==='id');
  assert.deepEqual(record,{kind:'id',namespace:'127.0.0.1:wordpress.post',id:'2630'});
  assert.ok(editor.targets.some(t=>t.url===origin+'/new-article/'));
  assert.ok(editor.elementFacts.draftText.includes('Article body'));
  assert.ok(!JSON.stringify(editor).includes('private-nonce'));
  await page.locator('form').evaluate(e=>e.insertAdjacentHTML('beforeend','<input type="hidden" name="post_ID" value="2631">'));
  assert.ok(!(await observeBotMemoryPage(1,{selector:'#publish'},api)).targets.some(t=>t.kind==='id'),'Ambiguous record IDs fail closed');
  await page.goto(origin+'/new-article/');
  await page.setContent('<link rel="https://api.w.org/" href="/wp-json/"><body class="single postid-2630"><article>Published article</article></body>');
  const published=await observeBotMemoryPage(1,{},api);
  assert.ok(published.targets.some(t=>JSON.stringify(t)===JSON.stringify(record)),'Published page retains the draft record identity');
  await page.locator('link').evaluate(e=>e.remove());
  assert.ok(!(await observeBotMemoryPage(1,{},api)).targets.some(t=>t.kind==='id'),'Unrelated pages do not acquire a WordPress identity');
  await browser.close();browser=null;console.log(build+': draft subject, submit label, public readback and ambiguous identity checks passed');
 }
}finally{await browser?.close();await new Promise(r=>server.close(r))}
