const STORAGE_KEY = 'openaiOauthTokens';
const CLIENT_ID = 'webbrain-extension';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT = 'https://auth.openai.com/oauth/callback';
const SCOPES = 'openid profile email offline_access';

function b64(bytes){let b='';for(const x of bytes)b+=String.fromCharCode(x);return btoa(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function sha(s){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return b64(new Uint8Array(h));}
function rand(n=32){return b64(crypto.getRandomValues(new Uint8Array(n)));}

export async function startOpenAIOAuth(){
  const verifier=rand(48), challenge=await sha(verifier), state=rand(16);
  const params=new URLSearchParams({client_id:CLIENT_ID,response_type:'code',redirect_uri:REDIRECT,scope:SCOPES,code_challenge:challenge,code_challenge_method:'S256',state});
  const tab=await chrome.tabs.create({url:`${AUTH_URL}?${params.toString()}`,active:true});
  return new Promise((resolve,reject)=>{
    const onUpdated=async (tabId,changeInfo)=>{ if(tabId!==tab.id||!changeInfo.url||!changeInfo.url.startsWith(REDIRECT)) return;
      chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.remove(tab.id).catch(()=>{});
      const u=new URL(changeInfo.url); const code=u.searchParams.get('code'); if(!code) return reject(new Error('Missing code'));
      try { const tokens=await exchangeCodeForTokens(code,verifier); resolve(tokens);} catch(e){reject(e);} };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function exchangeCodeForTokens(code,verifier){
  const res=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',code,redirect_uri:REDIRECT,client_id:CLIENT_ID,code_verifier:verifier})});
  if(!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const data=await res.json();
  const tokens={accessToken:data.access_token,refreshToken:data.refresh_token||null,expiresAt:Date.now()+((data.expires_in||3600)*1000)};
  await chrome.storage.local.set({[STORAGE_KEY]:tokens});
  return tokens;
}

export async function signOutOpenAI(){ await chrome.storage.local.remove([STORAGE_KEY]); }
export async function getOpenAIOAuthStatus(){ const d=await chrome.storage.local.get([STORAGE_KEY]); return {signedIn:!!d[STORAGE_KEY]?.accessToken}; }
export async function getOpenAIAccessToken(){ const d=await chrome.storage.local.get([STORAGE_KEY]); return d[STORAGE_KEY]?.accessToken||null; }
