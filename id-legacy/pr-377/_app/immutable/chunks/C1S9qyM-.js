import{a as n}from"./DWzJkOQD.js";import{g as t,v as i,S as c,h as u}from"./CzPL7qwU.js";const o=`Swarm ID

Sign this message to encrypt your recovery phrase on this device.

v1`;function l(){const e=window.ethereum;if(!e)throw new Error("No Ethereum wallet detected. Install a browser wallet and try again.");return e}async function g(){const e=l(),r=(await e.request({method:"eth_requestAccounts"}))[0];if(!r)throw new Error("No wallet account available.");const a=await e.request({method:"personal_sign",params:[o,r]});if(t(i(o,a))!==t(r))throw new Error("This wallet type is not supported for securing an account.");return{walletAddress:t(r),signature:c.from(a).serialized}}function h(e,s){return n(u(e.signature),s)}export{h as d,g as r};
