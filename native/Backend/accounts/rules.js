"use strict";
// Sign-up rules. The apps apply the same rules (gendragoon-apps packages/core/src/accounts/rules.ts); both
// test suites run contract/account_rules_vectors.json, so a change in one place fails the other until it matches.
const USERNAME_MIN=8,USERNAME_MAX=32,USERNAME_MIN_LETTERS=3;
const PASSWORD_MIN=12,PASSWORD_MAX=665;
const AGE_MAX=100;
// No account is ever made for anyone under 13. The minimum can be configured higher, never lower.
const MIN_AGE_FLOOR=13;
const PASSWORD_SYMBOLS="!@#$%^&*()-_=+[]{};:,.?/~|<>";
const USERNAME_SHAPE=/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const USERNAME_CHARS=/^[A-Za-z0-9._-]*$/;
const EMAIL_LOCAL=/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GMAIL_DOMAINS=new Set(["gmail.com","googlemail.com"]);
const TWO_FACTOR_METHODS=["totp","sms","redxai_auth","none"];

const ok={ok:true};
const fail=code=>({ok:false,code});
const letterCount=v=>(v.match(/[A-Za-z]/g)||[]).length;

function effectiveMinAge(configured){
 return Number.isInteger(configured)&&configured>MIN_AGE_FLOOR?Math.min(configured,AGE_MAX):MIN_AGE_FLOOR;
}
function checkUsername(value){
 if(typeof value!=="string"||value.length===0)return fail("username_required");
 if(value.length<USERNAME_MIN)return fail("username_too_short");
 if(value.length>USERNAME_MAX)return fail("username_too_long");
 if(!USERNAME_CHARS.test(value))return fail("username_bad_chars");
 if(!USERNAME_SHAPE.test(value))return fail("username_bad_edges");
 if(letterCount(value)<USERNAME_MIN_LETTERS)return fail("username_few_letters");
 return ok;
}
const usernameKey=v=>v.toLowerCase();
function checkPassword(value){
 if(typeof value!=="string"||value.length===0)return fail("password_required");
 if(/[\u0000-\u001f\u007f]/.test(value))return fail("password_bad_chars");
 const n=Array.from(value).length;
 if(n<PASSWORD_MIN||n>PASSWORD_MAX)return fail("password_length");
 if(!/[A-Z]/.test(value))return fail("password_upper");
 if(!/[a-z]/.test(value))return fail("password_lower");
 if(!/[0-9]/.test(value))return fail("password_digit");
 if(!Array.from(value).some(c=>PASSWORD_SYMBOLS.includes(c)))return fail("password_symbol");
 return ok;
}
const normalizeEmail=v=>v.trim().normalize("NFC").toLowerCase();
function emailKey(value){
 const email=normalizeEmail(value);const at=email.lastIndexOf("@");
 if(at<0)return email;
 let local=email.slice(0,at),domain=email.slice(at+1);
 if(GMAIL_DOMAINS.has(domain)){local=local.split("+")[0].replace(/\./g,"");domain="gmail.com";}
 return local+"@"+domain;
}
function emailDomain(value){const email=normalizeEmail(value);return email.slice(email.lastIndexOf("@")+1);}
function checkEmailFormat(value){
 if(typeof value!=="string"||value.trim().length===0)return fail("email_required");
 const email=normalizeEmail(value);
 if(email.length>254)return fail("email_invalid");
 const at=email.lastIndexOf("@");
 if(at<1||at!==email.indexOf("@"))return fail("email_invalid");
 const local=email.slice(0,at),domain=email.slice(at+1);
 if(local.length>64||!EMAIL_LOCAL.test(local))return fail("email_invalid");
 const labels=domain.split(".");
 if(labels.length<2||domain.length>253)return fail("email_invalid");
 if(!labels.every(l=>DOMAIN_LABEL.test(l)))return fail("email_invalid");
 const tld=labels[labels.length-1];
 if(!/^[a-z]{2,63}$/.test(tld)&&!/^xn--[a-z0-9-]+$/.test(tld))return fail("email_invalid");
 return ok;
}
function parseBirthDate(value){
 if(typeof value!=="string")return null;
 const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
 if(!m)return null;
 const month=Number(m[1]),day=Number(m[2]),year=Number(m[3]);
 if(month<1||month>12||day<1||year<1800)return null;
 const d=new Date(Date.UTC(year,month-1,day));
 if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;
 return {year,month,day};
}
const pad=(n,w)=>String(n).padStart(w,"0");
const birthDateToIso=d=>pad(d.year,4)+"-"+pad(d.month,2)+"-"+pad(d.day,2);
function birthDateFromIso(value){
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||""));
 return m?parseBirthDate(m[2]+"/"+m[3]+"/"+m[1]):null;
}
// Age is always computed from the stored date of birth, never stored.
function ageOn(dob,now){
 const y=now.getUTCFullYear(),m=now.getUTCMonth()+1,d=now.getUTCDate();
 let age=y-dob.year;
 if(m<dob.month||(m===dob.month&&d<dob.day))age-=1;
 return age;
}
function checkBirthDate(value,{now,minAge}={}){
 if(typeof value!=="string"||value.trim().length===0)return fail("dob_required");
 const dob=parseBirthDate(value);
 if(!dob)return fail("dob_invalid");
 const age=ageOn(dob,now);
 if(age<0)return fail("dob_future");
 if(age>AGE_MAX)return fail("dob_out_of_range");
 if(age<effectiveMinAge(minAge))return fail("dob_under_min_age");
 return ok;
}
const normalizePhone=v=>String(v).replace(/[\s().-]/g,"");
function checkPhone(value){
 if(typeof value!=="string")return fail("phone_required");
 return /^\+[1-9][0-9]{7,14}$/.test(normalizePhone(value))?ok:fail("phone_invalid");
}
// The server form of validateSignup in core: same fields, same codes.
function validateSignup(fields,{now,minAge,requirePassword}){
 const errors={};const put=(field,check)=>{if(!check.ok)errors[field]=check.code;};
 const f=fields||{};
 put("username",checkUsername(f.username));
 put("email",checkEmailFormat(f.email));
 if(!errors.email&&normalizeEmail(typeof f.emailConfirm==="string"?f.emailConfirm:"")!==normalizeEmail(f.email))errors.emailConfirm="email_mismatch";
 if(requirePassword){
  put("password",checkPassword(f.password));
  if(!errors.password&&f.passwordConfirm!==f.password)errors.passwordConfirm="password_mismatch";
 }
 put("birthDate",checkBirthDate(f.birthDate,{now,minAge}));
 if(!f.twoFactor)errors.twoFactor="two_factor_required";
 else if(f.twoFactor==="redxai_auth")errors.twoFactor="two_factor_unavailable";
 else if(!TWO_FACTOR_METHODS.includes(f.twoFactor))errors.twoFactor="two_factor_invalid";
 else if(f.twoFactor==="none"&&f.noTwoFactorAcknowledged!==true)errors.twoFactor="no_two_factor_ack_required";
 else if(f.twoFactor==="sms")put("phone",checkPhone(f.phone));
 if(f.falseInfoAcknowledged!==true)errors.falseInfo="false_info_ack_required";
 return errors;
}
module.exports={USERNAME_MIN,USERNAME_MAX,USERNAME_MIN_LETTERS,PASSWORD_MIN,PASSWORD_MAX,AGE_MAX,MIN_AGE_FLOOR,PASSWORD_SYMBOLS,
 TWO_FACTOR_METHODS,effectiveMinAge,checkUsername,usernameKey,checkPassword,normalizeEmail,emailKey,emailDomain,checkEmailFormat,
 parseBirthDate,birthDateToIso,birthDateFromIso,ageOn,checkBirthDate,checkPhone,normalizePhone,validateSignup};
