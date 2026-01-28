function n(n){const t=n.replace(/\s/g,"");if(t.length%2!=0)throw new Error("Invalid hex string: length must be even");const r=new Uint8Array(t.length/2);for(let n=0;n<t.length;n+=2)r[n/2]=parseInt(t.substring(n,n+2),16);return r}function t(n){return Array.from(n).map(n=>n.toString(16).padStart(2,"0")).join("")}export{n as hexToUint8Array,t as uint8ArrayToHex};
//# sourceMappingURL=hex.js.map
