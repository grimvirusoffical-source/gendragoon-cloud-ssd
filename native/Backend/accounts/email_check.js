"use strict";
// Email deliverability: the domain must accept mail. A domain with MX records accepts mail unless it publishes a
// null MX (RFC 7505). A domain with no MX falls back to its A/AAAA record (RFC 5321 section 5.1). Custom business
// domains pass like any other. DNS failures are "unverifiable" (try again), not "undeliverable".
// Disposable (throwaway) domains are refused before any DNS lookup, from the list in disposable_domains.txt.
const dns=require("node:dns").promises;
const fs=require("node:fs");
const path=require("node:path");
const {checkEmailFormat,emailDomain}=require("./rules");
const NO_RECORD=new Set(["ENODATA","ENOTFOUND","ENONAME","NXDOMAIN"]);

function loadDisposable(file=path.join(__dirname,"disposable_domains.txt")){
 const set=new Set();
 for(const line of fs.readFileSync(file,"utf8").split("\n")){const d=line.trim().toLowerCase();if(d&&!d.startsWith("#"))set.add(d);}
 return set;
}
const DISPOSABLE=loadDisposable();
// True for a listed domain or any subdomain of one (mx.mailinator.com).
function isDisposable(domain,list=DISPOSABLE){
 const labels=String(domain||"").toLowerCase().replace(/\.+$/,"").split(".");
 for(let i=0;i<labels.length-1;i++)if(list.has(labels.slice(i).join(".")))return true;
 return false;
}

function createEmailChecker({resolver=dns,ttlMs=10*60_000,timeoutMs=4000,now=()=>Date.now(),disposable=DISPOSABLE}={}){
 const cache=new Map();
 const withTimeout=p=>Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(Error("timeout"),{code:"ETIMEOUT"})),timeoutMs).unref?.())]);
 async function lookup(fn,domain){
  try{return {records:await withTimeout(resolver[fn](domain))};}
  catch(error){return NO_RECORD.has(error?.code)?{records:[]}:{error};}
 }
 async function domainStatus(domain){
  const hit=cache.get(domain);
  if(hit&&hit.until>now())return hit.status;
  let status;
  const mx=await lookup("resolveMx",domain);
  if(mx.error)status="unverifiable";
  else if(mx.records.length>0){
   const real=mx.records.filter(r=>r&&typeof r.exchange==="string"&&r.exchange!==""&&r.exchange!==".");
   status=real.length>0?"deliverable":"undeliverable";
  }else{
   const [a,aaaa]=await Promise.all([lookup("resolve4",domain),lookup("resolve6",domain)]);
   if(a.records?.length||aaaa.records?.length)status="deliverable";
   else if(a.error&&aaaa.error)status="unverifiable";
   else status="undeliverable";
  }
  if(status!=="unverifiable")cache.set(domain,{status,until:now()+ttlMs});
  return status;
 }
 // {ok:true} | {ok:false,code}
 async function check(email){
  const format=checkEmailFormat(email);
  if(!format.ok)return format;
  if(isDisposable(emailDomain(email),disposable))return {ok:false,code:"email_disposable"};
  const status=await domainStatus(emailDomain(email));
  if(status==="deliverable")return {ok:true};
  return {ok:false,code:status==="undeliverable"?"email_domain":"email_unverifiable"};
 }
 return {check,domainStatus};
}
module.exports={createEmailChecker,isDisposable,loadDisposable};
